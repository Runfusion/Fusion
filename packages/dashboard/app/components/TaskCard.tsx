import "./TaskCard.css";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { memo, useCallback, useState, useRef, useEffect, useLayoutEffect, useMemo, type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Link, Clock, Layers, Pencil, ChevronDown, Folder, Target, Bot, Trash2, RotateCw, Zap, GitBranch, GitPullRequest, AlertTriangle, Eye, MoreHorizontal, Sparkles, X } from "lucide-react";
import { isTaskExternallyBlocked } from "@fusion/core";
import type { Task, TaskDetail, Column, ColumnId, PrInfo, IssueInfo, TaskPriority, GithubIssueAction, MergeResult, PlannerOversightLevel } from "@fusion/core";
import {
  DEFAULT_PLANNER_OVERSIGHT_LEVEL,
  DEFAULT_TASK_PRIORITY,
  HIGH_FANOUT_BLOCKER_TODO_THRESHOLD,
  PLANNER_OVERSIGHT_LEVELS,
  TASK_PRIORITIES,
  getErrorMessage,
} from "@fusion/core";
import { resolveEffectiveAutoMerge } from "../../../core/src/merge/task-merge";
// FNXC:PlannerOversight 2026-07-04-00:00: the dashboard's vite alias for "@fusion/core"
// resolves only to ../core/src/types.ts (see packages/dashboard/vite.config.ts), so this
// resolver — like resolveEffectiveAutoMerge above — must be imported from its source module
// directly rather than the package barrel.
import { resolveEffectivePlannerOversightLevel } from "../../../core/src/workflows/workflow-settings-resolver";
import { addressPrFeedback, approvePlan, fetchTaskDetail, uploadAttachment, fetchMission, fetchAgent, refreshPrStatus, fetchWorkflowSettingValues, fetchBoardWorkflows, type WorkflowFieldDefinition, type RevertTaskOptions, type RevertTaskResult } from "../api";
import { GitHubBadge } from "./GitHubBadge";
import { GitLabBadge } from "./GitLabBadge";
import { RuntimeFallbackBadge } from "./RuntimeFallbackBadge";
import { PrCreateModal } from "./PrCreateModal";
import { TaskResetDialog } from "./TaskResetDialog";
import { ProviderIcon } from "./ProviderIcon";
import { PluginSlot } from "./PluginSlot";
import { useBadgeWebSocket } from "../hooks/useBadgeWebSocket";
import { plannerOverseerBadgeTooltip, plannerOverseerStateLabel } from "./plannerOverseerBadge";
import { getFreshBatchData } from "../hooks/useBatchBadgeFetch";
import { useTaskDiffStats } from "../hooks/useTaskDiffStats";
import { useAgentsMapCache } from "../hooks/useAgentsMapCache";
import { useLiveTimeTicker } from "../hooks/useLiveTimeTicker";
import {
  isCompleteColumnRole,
  isFieldEditableColumnRole,
  isPreImplementationColumnRole,
  isReviewColumnRole,
  isWipColumnRole,
} from "../utils/columnRoles";
import { hasPendingAutomaticRecovery } from "../utils/taskRecovery";
import { resolveRetryStageCopy } from "../utils/taskRetryCopy";
import { getRevertOfId, isTaskReverted } from "../utils/taskRevert";
import { getStalledReviewSignal } from "../utils/taskStalledReview";
import { getInReviewStallCopy, shouldShowInReviewStallBadge } from "../utils/inReviewStallCopy";
import { getStalePausedReviewCopy, shouldShowStalePausedReviewBadge } from "../utils/stalePausedReviewCopy";
import { getTaskAgeStalenessCopy, shouldShowTaskAgeStalenessBadge } from "../utils/taskAgeStalenessCopy";
import {
  getRunningOptionalGateBadge,
  getRunningWorkflowStepLabel,
  getUnifiedTaskProgress,
  isNonPlanningOptionalGateBadge,
  isPlanReviewRunning,
} from "../utils/taskProgress";
import { ACTIVE_STATUSES, isTaskAgentActive } from "../utils/taskActivity";
import { getPrBadgeModifierClass } from "../utils/prBadgeClass";
import { getTotalAgentActiveMs, getEndToEndDurationMs, getTimedDurationMs, getWorkflowRuntimeMs, parseTimestampToMs } from "../utils/taskTiming";
import { getTaskStatusBadgeLabel, getTaskWipLifecycleBadgeLabel, type TaskStatusBadgeContext, hasTaskStatusBadge, isTaskPlanningActive } from "../utils/taskStatusBadgeLabel";
import {
  isReviewBudgetExhaustedApproval,
  isTaskAwaitingPlanApproval,
} from "../utils/reviewBudgetApproval";
import { canStartPrFeedbackAddressing, getTaskPrimaryPrInfo } from "../utils/prFeedback";
import type { ToastType } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";
import { runDuplicateTaskAction } from "../utils/duplicateTaskAction";
import { extractDependencyDeleteConflict, extractLineageDeleteConflict } from "../utils/taskDelete";
import { MAX_AUTO_MERGE_RETRIES, type BlockerFanoutEntry } from "../hooks/useBlockerFanout";
import { useRetryWarning } from "../context/RetryWarningContext";
import { useCostBadge } from "../context/CostBadgeContext";
import { useColumnLabel } from "../i18n/labels";
import { formatCompactLifecycleDate, useLocaleFormat } from "../i18n/format";
import { WorkspaceWorktreesSummary, isWorkspaceTask } from "./WorkspaceWorktreesSummary";
import { WorkflowIcon } from "./WorkflowIcon";
import { TaskContextMenu, buildTaskActionMenuModel, getTaskPrAutomationLabel, type TaskContextMenuColumnFlags, type TaskContextMenuColumnMetadata, type TaskMenuItemDescriptor } from "./TaskContextMenu";
import { formatCost, hasTaskCost, taskTotalCost } from "../utils/taskTokenCost";
import { getPriorityColorVar, getPriorityIcon, getPriorityLabel } from "../utils/priorityIndicator";
import { getTaskTitleDisplay } from "../utils/taskTitleDisplay";
import {
  WORKFLOW_SETTING_VALUES_UPDATED_EVENT,
  getWorkflowSettingValuesKey,
  getWorkflowSettingValuesRevision,
  type WorkflowSettingValuesUpdatedDetail,
} from "../utils/workflowSettingValuesEvents";

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

// ── Workflow-effective planner-oversight-level caching ─────────────────────

/*
 * FNXC:PlannerOversight 2026-07-18-13:18:
 * Code review (FN-7516) flagged that always resolving with an `undefined`
 * workflow tier makes every task without a per-task override display
 * "Autonomous recovery", even when the task's workflow was explicitly
 * configured to Off/Observe/Steer (FN-7508). The workflow's effective
 * `plannerOversightLevel` setting value is NOT present on the Task payload
 * (verified: no such field exists in packages/core/src/types.ts or in any
 * task-list/detail serialization path), so the card cannot read it via
 * `task.*` alone. The card therefore resolves the authoritative value through
 * a request keyed by `(projectId, workflowId)`, populated
 * by a self-contained fetch to the
 * existing `GET /api/workflows/:id/setting-values` route (already used by the
 * workflow editor's Values tab), with in-flight de-duplication so cards sharing
 * one workflow trigger a single network call. Completed values are deliberately
 * not cached across mounts. Successful local writes and authoritative
 * workflow-setting SSE mutations invalidate mounted cards, so turning oversight
 * off cannot retain an old active tier across browser/server write surfaces.
 * Round-2 code review:
 * the very first render before the fetch resolves must NOT show a guessed
 * schema-default badge — see `workflowOversightResolved` near the effect
 * below, which gates both oversight badges until the workflow tier is known
 * (or a synchronous per-task override makes the wait moot). Threading this
 * value onto the task payload directly for zero-latency display remains a
 * possible follow-up (see FN-7516 delivery notes) but is no longer required
 * for correctness.
 */
type WorkflowOversightResolution = {
  level: PlannerOversightLevel | undefined;
  resolved: boolean;
  /** FNXC:PlannerOversight 2026-07-17-15:50: Cache identity prevents an old workflow's active tier leaking during a prop switch. */
  workflowCacheKey?: string;
  settingsRevision?: number;
};

const workflowOversightInflight = new Map<string, Promise<WorkflowOversightResolution>>();

/** @internal Test helper to reset in-flight workflow oversight requests between tests */
export function __test_clearWorkflowOversightEffectiveCache(): void {
  workflowOversightInflight.clear();
}

function getWorkflowOversightCacheKey(workflowId: string, projectId?: string): string {
  return getWorkflowSettingValuesKey(workflowId, projectId);
}

function normalizeWorkflowId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function isPlannerOversightLevelValue(value: unknown): value is PlannerOversightLevel {
  return typeof value === "string" && (PLANNER_OVERSIGHT_LEVELS as readonly string[]).includes(value);
}

/** Fetch (with in-flight de-dup) the workflow's current effective
 *  `plannerOversightLevel` setting value for a given `(workflowId, projectId)`.
 *  Never throws; failed or malformed responses stay explicitly unresolved so
 *  callers cannot mistake an unknown inherited tier for the schema default. */
async function loadWorkflowOversightEffectiveLevel(workflowId: string, projectId: string | undefined): Promise<WorkflowOversightResolution> {
  const key = getWorkflowOversightCacheKey(workflowId, projectId);
  const revision = getWorkflowSettingValuesRevision(workflowId, projectId);
  const inflightKey = `${key}::${revision}`;

  let inflight = workflowOversightInflight.get(inflightKey);
  if (!inflight) {
    inflight = fetchWorkflowSettingValues(workflowId, projectId)
      .then((payload) => {
        const raw = payload.effective?.plannerOversightLevel;
        return isPlannerOversightLevelValue(raw)
          ? { level: raw, resolved: true, settingsRevision: revision }
          : { level: undefined, resolved: false, settingsRevision: revision };
      })
      .catch(() => ({ level: undefined, resolved: false, settingsRevision: revision }))
      .finally(() => {
        workflowOversightInflight.delete(inflightKey);
      });
    workflowOversightInflight.set(inflightKey, inflight);
  }
  return inflight;
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

/*
 * FNXC:PlannerOversight 2026-07-04-00:00:
 * Short card-badge labels + CSS modifier suffixes for each non-"off" effective
 * oversight level (FN-7516). Kept short to preserve the badge-wrap/badge-height
 * invariants asserted by TaskCard.badge-wrap.test.tsx.
 */
const OVERSIGHT_BADGE_LABEL: Record<Exclude<PlannerOversightLevel, "off">, string> = {
  observe: "Observe",
  steer: "Steer",
  autonomous: "Auto-recovery",
};
const OVERSIGHT_BADGE_MODIFIER: Record<Exclude<PlannerOversightLevel, "off">, string> = {
  observe: "observe",
  steer: "steer",
  autonomous: "autonomous",
};

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

function getNormalizedAgentIdentity(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * FNXC:TaskCardAgentBadges 2026-07-20-00:00:
 * FN-8423 requires TaskCard to retain assigned ownership but suppress redundant
 * created-by provenance only for the same agent identity. IDs are authoritative:
 * distinct present IDs stay distinct even when their display names collide; names
 * are a case-insensitive fallback only when either identity has no usable ID.
 */
function isSameAgentIdentity(
  assignedAgentId: string | undefined,
  sourceAgentId: string | undefined,
  assignedAgentName: string | null | undefined,
  sourceAgentName: string | undefined,
): boolean {
  const normalizedAssignedId = getNormalizedAgentIdentity(assignedAgentId);
  const normalizedSourceId = getNormalizedAgentIdentity(sourceAgentId);

  if (normalizedAssignedId && normalizedSourceId) {
    return normalizedAssignedId === normalizedSourceId;
  }

  const normalizedAssignedName = getNormalizedAgentIdentity(assignedAgentName)?.toLocaleLowerCase();
  const normalizedSourceName = getNormalizedAgentIdentity(sourceAgentName)?.toLocaleLowerCase();
  return Boolean(normalizedAssignedName && normalizedSourceName && normalizedAssignedName === normalizedSourceName);
}

// ── Constants ───────────────────────────────────────────────────────────────

// Issue 1403: widened to ColumnId so `.has(task.column)` accepts custom column ids
// (which are not members and correctly resolve to false).

const ACTIVE_MERGE_STATUSES = new Set(
  [...ACTIVE_STATUSES].filter((status) => ["merging", "merging-pr", "merging-fix", "reviewing", "landing"].includes(status)),
);

const COLUMN_PROGRESS_COLOR_MAP: Partial<Record<Column, string>> = {
  triage: "var(--triage)",
  todo: "var(--todo)",
  "in-progress": "var(--in-progress)",
  "in-review": "var(--in-review)",
  done: "var(--done)",
};

const TIME_INDICATOR_COLUMNS = new Set<ColumnId>([
  "in-progress",
  "in-review",
  "done",
]);
// FNXC:BoardPerformance 2026-07-26-09:48: LIVE_TIME_INDICATOR_POLL_MS now lives with the shared
// ticker (`hooks/useLiveTimeTicker`) so the cadence and the single timer that honors it cannot drift.

/*
FNXC:TaskCardStatus 2026-07-22-00:00:
FN-8482 requires compact no-ellipsis active-merge labels on task cards, while the shared
status mapper retains its ellipsis-bearing output for ListView and other non-card surfaces.
Only strip a terminal Unicode ellipsis after the shared mapper resolves one of the active
merge statuses so non-merge labels, status routing, and localization remain unchanged.
*/
function getTaskStatusLabel(status: string, t: TFunction<"app">, workflowStepLabel?: string, context?: TaskStatusBadgeContext): string {
  const label = getTaskStatusBadgeLabel(status, t, workflowStepLabel, context);
  return ACTIVE_MERGE_STATUSES.has(status) && label.endsWith("…") ? label.slice(0, -1) : label;
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
function getTaskEndToEndDurationMs(
  task: Task,
  nowMs: number,
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-10:10:
  THREADED SO THE CONVERSION IS NOT INERT. `getTotalAgentActiveMs` gained an optional `columnFlags`
  so the LIVE execution segment is counted from the card's own wip lane. This is one of its two
  production callers, and it passed nothing — so the resolved path existed and never ran, and the
  card chip under-reported the in-flight run on a renamed board by exactly its elapsed time.

  An optional parameter no production caller supplies is a conversion that reads as done and behaves
  as the literal: the census drops and nothing changes. Threading it here is what makes it real.
  */
  columnFlags?: TaskContextMenuColumnFlags,
): number | null {
  // FNXC:TaskTiming 2026-07-20-12:00: planning-only tasks have no execution
  // accumulator, but their active AI duration still belongs on the card chip.
  // Use the legacy execution window only when neither active-time source exists.
  const totalActiveMs = getTotalAgentActiveMs(task, nowMs, columnFlags);
  return totalActiveMs ?? getEndToEndDurationMs(task.executionStartedAt, task.executionCompletedAt, nowMs);
}

/*
FNXC:WorkflowResolvedColumns 2026-07-30-01:20 (fleet phase — FLAGGED AND LEFT COUNTED):
Module-scope, takes only a `Task`, and has no flags to consult. Converting it means either threading
resolved flags through a pure duration helper or resolving a workflow inside it — the same shape flagged
at `project-engine.ts:2555` and `github-tracking-comments.ts:165`. Left counted so the census keeps
pointing at the class rather than at me having decided it away.

FNXC:WorkflowResolvedColumns 2026-07-31-23:59 — THAT BLOCKER HAS SINCE EXPIRED, and the evidence is in
this file.

"Has no flags to consult" was true when written and is not true now. `taskColumnFlags` is a prop of
this component, destructured and already consumed by `isWipColumnRole` / `isReviewColumnRole` a few
hundred lines below, and `TaskContextMenuColumnFlags` carries `complete`. The sibling duration helpers
here were threaded for exactly this reason — `getTotalAgentActiveMs` carries the note "THREADED SO THE
CONVERSION IS NOT INERT". This helper has ONE caller, inside the component, where the flags are in
scope.

So the threading the note called prohibitive is already done; only this helper was left behind. The
flags are OPTIONAL and the legacy id remains the fallback (`isCompleteColumnRole`), so a caller without
resolved flags behaves exactly as before.

WHAT THE LITERAL COST: on a board whose complete lane is renamed, `task.column === "done"` matched
nothing, so a finished card showed its execution time WITHOUT the completion timestamp — the "done N
ago" half of the label simply never appeared. Cosmetic, but only visible on renamed boards, which is
why nobody reported it.

A DECAYED DEFERRAL, recorded as such: this program's learnings say a deferral's stated blocker is a
claim that ages like any measurement. Mine aged out in one day, and I re-read it twice this week and
took it at face value both times.
*/
function getInReviewCompletionMs(task: Task, columnFlags?: TaskContextMenuColumnFlags): number | null {
  return isCompleteColumnRole(columnFlags, task.column) ? getDoneCompletionMs(task) : null;
}

function getMergeElapsedMs(task: Task, nowMs: number): number | null {
  const mergeStartedMs = parseTimestampToMs(task.updatedAt);
  if (mergeStartedMs == null) {
    return null;
  }

  return Math.max(0, nowMs - mergeStartedMs);
}

function getActiveMergeTotalMs(task: Task, nowMs: number, columnFlags?: TaskContextMenuColumnFlags): number | null {
  const endToEndMs = getTaskEndToEndDurationMs(task, nowMs, columnFlags);
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

interface ExternalBlockNoticeProps {
  task: Task;
  variant: "card" | "list" | "detail";
  onOpenChatWithPrefill?: (prefillText: string) => void;
  onRetryTask?: (id: string) => Promise<Task>;
  addToast?: (message: string, type?: ToastType) => void;
}

/*
FNXC:ExternalBlockUx 2026-08-28-04:56:
Every task surface uses one external-obstacle notice so Blocked always wins over paused, failure,
dependency, and file-overlap vocabulary. Action buttons exist only when their real handlers exist;
the explanation prompt carries the durable raw code/message and Retry resumes without the normal
destructive stage-restart confirmation.
*/
export function ExternalBlockNotice({ task, variant, onOpenChatWithPrefill, onRetryTask, addToast }: ExternalBlockNoticeProps) {
  const { t } = useTranslation("app");
  const [isResuming, setIsResuming] = useState(false);
  const block = task.externalBlock;
  if (!isTaskExternallyBlocked(task) || !block) return null;
  const code = block.code.trim() || t("tasks.externalBlock.unknownCode", "UNCLASSIFIED");
  const message = block.message.trim() || t("tasks.externalBlock.genericMessage", "External obstacle requires operator action");
  const error = `${code}: ${message}`;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const explain = (event: React.MouseEvent<HTMLButtonElement>) => {
    stop(event);
    onOpenChatWithPrefill?.(t("tasks.externalBlock.explainPrompt", "Explain this error {{error}} and how to resolve it.", { error }));
  };
  const retry = async (event: React.MouseEvent<HTMLButtonElement>) => {
    stop(event);
    if (!onRetryTask || isResuming) return;
    setIsResuming(true);
    try {
      await onRetryTask(task.id);
    } catch (reason) {
      addToast?.(t("tasks.retryFailed", "Failed to retry {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(reason) }), "error");
    } finally {
      setIsResuming(false);
    }
  };
  return (
    <div className={`external-block-notice external-block-notice--${variant}`} role="alert" data-testid={`external-block-${variant}-${task.id}`}>
      <strong className="external-block-notice__title">{t("tasks.externalBlock.title", "Blocked")}</strong>
      <span className="external-block-notice__reason">{error}</span>
      {(onOpenChatWithPrefill || onRetryTask) && (
        <span className="external-block-notice__actions">
          {onOpenChatWithPrefill && (
            <button type="button" className="btn btn-icon" onClick={explain} aria-label={t("tasks.externalBlock.explain", "Explain this error")} title={t("tasks.externalBlock.explain", "Explain this error")}>
              <Bot aria-hidden="true" />
            </button>
          )}
          {onRetryTask && (
            <button type="button" className="btn" onClick={(event) => void retry(event)} disabled={isResuming}>
              <RotateCw aria-hidden="true" />
              {isResuming ? t("tasks.externalBlock.resuming", "Resuming…") : t("tasks.externalBlock.retry", "Retry")}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

interface PlanApprovalNoticeProps {
  task: Task;
  variant: "card" | "list" | "detail";
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  onTaskUpdated?: (task: Task) => void;
  isPlanningLane?: boolean;
}

/*
FNXC:PlanApproval 2026-08-28-16:31:
Every board surface shares one approval notice. Approve is the only in-notice control and stops propagation so card navigation never wins; operators who need to restate and restart the task use the separate Reset dialog.
*/
export function PlanApprovalNotice({
  task,
  variant,
  projectId,
  addToast,
  onTaskUpdated,
  isPlanningLane = true,
}: PlanApprovalNoticeProps) {
  const { t } = useTranslation("app");
  const [isApproving, setIsApproving] = useState(false);
  const awaitingApproval = isTaskAwaitingPlanApproval(task, isPlanningLane);
  if (isTaskExternallyBlocked(task) || !awaitingApproval) return null;

  const replanCap = isReviewBudgetExhaustedApproval(task);
  /*
  FNXC:PlanApproval 2026-09-05-22:04:
  Board and List rows are slim and never carry prompt, so a client prompt gate makes the enabled primary action silently fail after a reload. The approve-plan endpoint owns status, column, and PROMPT.md validation; its refusal is shown through this notice's error toast.
  */
  const approve = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (isApproving) return;
    setIsApproving(true);
    try {
      const updated = await approvePlan(task.id, projectId);
      addToast(t("taskDetail.plan.approved", "Plan approved — {{id}} moved to Todo", { id: task.id }), "success");
      onTaskUpdated?.(updated);
    } catch (error) {
      addToast(t("tasks.planApproval.approveFailed", "Failed to approve plan: {{error}}", { error: getErrorMessage(error) }), "error");
      setIsApproving(false);
    }
  };

  return (
      <div
        className={`plan-approval-notice plan-approval-notice--${variant}`}
        role="alert"
        data-testid={`plan-approval-${variant}-${task.id}`}
        onClick={(event) => event.stopPropagation()}
      >
        <strong className="plan-approval-notice__title">
          {replanCap
            ? t("taskDetail.plan.replanCapHeadline", "Approval needed: Plan Review did not converge")
            : t("tasks.planApproval.title", "Need Your Review")}
        </strong>
        <span className="plan-approval-notice__copy">
          {replanCap
            ? t("tasks.planApproval.replanCapCopy", "Review the current plan, then approve it or request specific changes.")
            : t("tasks.planApproval.copy", "Review the plan before implementation starts.")}
        </span>
        <span className="plan-approval-notice__actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={(event) => void approve(event)} disabled={isApproving}>
            {isApproving ? t("tasks.planApproval.approving", "Approving...") : t("tasks.planApproval.approve", "Approve")}
          </button>
        </span>
      </div>
  );
}

interface TaskCardProps {
  task: Task;
  projectId?: string;
  queued?: boolean;
  onOpenDetail: (task: Task | TaskDetail) => void;
  /**
   * FNXC:TaskCardPlanning 2026-07-13-00:00:
   * Board/List cards in pre-execution hold columns can seed Planning Mode from their own task description/title. The callback is optional so read-only/dock hosts omit the Plan menu item instead of rendering a dead shell.
   */
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  /** Workflow selection to preserve when Planning Mode is launched from workflow-aware board cards. */
  planningWorkflowId?: string | null;
  onOpenRefine?: (task: Task | TaskDetail) => void;
  onOpenGroupModal?: (groupId: string) => void;
  addToast: (message: string, type?: ToastType) => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[]; dismissNearDuplicate?: boolean; githubTracking?: { enabled?: boolean } }
  ) => Promise<Task>;
  onRevertTask?: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
  /** Resolution action for a successfully reverted task. */
  onReviseTask?: (task: Task) => void;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  onPauseTask?: (id: string) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onOpenChatWithPrefill?: (prefillText: string) => void;
  onUnpauseTask?: (id: string) => Promise<Task>;
  onResetTask?: (id: string, options?: { description?: string }) => Promise<Task>;
  onDuplicateTask?: (id: string, options?: { workflowId?: string }) => Promise<Task>;
  onMergeTask?: (id: string) => Promise<MergeResult>;
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => void;
  /*
  FNXC:StuckTagRemoval 2026-08-17-22:30: Operator removed stuck-task tagging from the dashboard; engine recovery sweeps still consume taskStuckTimeoutMs server-side.
  TaskCard no longer takes taskStuckTimeoutMs or renders stuck classes/badges; lastFetchTimeMs stays for retry/recovery freshness checks.
  */
  /** Called when user clicks the mission badge on a task card. */
  onOpenMission?: (missionId: string) => void;
  /** Called when user moves a task to a different column from the card. */
  onMoveTask?: (id: string, column: ColumnId, optionsOrPosition?: { preserveProgress?: boolean; expectedColumn?: string } | number) => Promise<Task>;
  /** Workflow-column flags for this task's current column, used for detail-equivalent card action availability. */
  taskColumnFlags?: TaskContextMenuColumnFlags;
  /** Ordered workflow columns that define card move targets in workflow-column mode. */
  taskMoveColumns?: readonly TaskContextMenuColumnMetadata[];
  /** Timestamp (ms) when task data was last confirmed fresh from the server. */
  lastFetchTimeMs?: number;
  /** Downstream fan-out entry for this task, computed at board-level. */
  fanout?: BlockerFanoutEntry;
  /** Whether GitHub CLI auth is available for creating PRs from task cards. */
  prAuthAvailable?: boolean;
  /** Project default auto-merge setting; per-task overrides are applied via resolveEffectiveAutoMerge. */
  autoMergeEnabled?: boolean;
  /** Project merge strategy so manual PR tasks match Task Detail before a PR exists. */
  mergeStrategy?: string;
  /** Card-placed custom field definitions for this task's workflow (U13/KTD-14).
   *  Empty/undefined → no field badges render (card byte-identical to today). */
  cardFieldDefs?: WorkflowFieldDefinition[];
  /** Board aggregate-view workflow metadata. Absent outside trusted board callers so empty workflow badges never render. */
  workflowBadge?: { workflowId: string; workflowName: string; workflowIcon?: string };
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
function millisecondsUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 25);
  return Math.max(1, next.getTime() - now.getTime());
}

function areTaskCardPropsEqual(previous: TaskCardProps, next: TaskCardProps): boolean {
  const previousTask = previous.task;
  const nextTask = next.task;

  return (
    previous.queued === next.queued &&
    previous.projectId === next.projectId &&
    previous.globalPaused === next.globalPaused &&
    previous.prAuthAvailable === next.prAuthAvailable &&
    previous.autoMergeEnabled === next.autoMergeEnabled &&
    previous.mergeStrategy === next.mergeStrategy &&
    previous.onOpenPullRequest === next.onOpenPullRequest &&
    previous.prNode?.id === next.prNode?.id &&
    previous.prNode?.state === next.prNode?.state &&
    previous.prNode?.prNumber === next.prNode?.prNumber &&
    previous.cliSessionState?.agentState === next.cliSessionState?.agentState &&
    previous.nearDuplicateCanonicalInactive === next.nearDuplicateCanonicalInactive &&
    previous.workflowBadge?.workflowId === next.workflowBadge?.workflowId &&
    previous.workflowBadge?.workflowName === next.workflowBadge?.workflowName &&
    previous.workflowBadge?.workflowIcon === next.workflowBadge?.workflowIcon &&
    previous.planningWorkflowId === next.planningWorkflowId &&
    previous.taskColumnFlags === next.taskColumnFlags &&
    previous.taskMoveColumns === next.taskMoveColumns &&
    previous.cardFieldDefs === next.cardFieldDefs &&
    (previous.cardFieldDefs == null && next.cardFieldDefs == null
      ? true
      : JSON.stringify(previousTask.customFields ?? null) === JSON.stringify(nextTask.customFields ?? null)) &&
    previous.onOpenDetail === next.onOpenDetail &&
    previous.onPlanningMode === next.onPlanningMode &&
    previous.onOpenGroupModal === next.onOpenGroupModal &&
    previous.addToast === next.addToast &&
    previous.onUpdateTask === next.onUpdateTask &&
    previous.onRevertTask === next.onRevertTask &&
    previous.onDeleteTask === next.onDeleteTask &&
    previous.onPauseTask === next.onPauseTask &&
    previous.onRetryTask === next.onRetryTask &&
    previous.onOpenChatWithPrefill === next.onOpenChatWithPrefill &&
    previous.onUnpauseTask === next.onUnpauseTask &&
    previous.onResetTask === next.onResetTask &&
    previous.onDuplicateTask === next.onDuplicateTask &&
    previous.onMergeTask === next.onMergeTask &&
    previous.onOpenDetailWithTab === next.onOpenDetailWithTab &&
    previous.onOpenRefine === next.onOpenRefine &&
    previous.onOpenMission === next.onOpenMission &&
    previous.onMoveTask === next.onMoveTask &&
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
    previousTask.executionCompletedAt === nextTask.executionCompletedAt &&
    previousTask.archivedAt === nextTask.archivedAt &&
    previousTask.status === nextTask.status &&
    previousTask.recentAgentActivityAt === nextTask.recentAgentActivityAt &&
    previousTask.priority === nextTask.priority &&
    previousTask.executionMode === nextTask.executionMode &&
    previousTask.paused === nextTask.paused &&
    previousTask.userPaused === nextTask.userPaused &&
    previousTask.error === nextTask.error &&
    previousTask.externalBlock?.blockedAt === nextTask.externalBlock?.blockedAt &&
    previousTask.externalBlock?.code === nextTask.externalBlock?.code &&
    previousTask.externalBlock?.message === nextTask.externalBlock?.message &&
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
    previousTask.currentStep === nextTask.currentStep &&
    previousTask.modelProvider === nextTask.modelProvider &&
    previousTask.modelId === nextTask.modelId &&
    previousTask.validatorModelProvider === nextTask.validatorModelProvider &&
    previousTask.validatorModelId === nextTask.validatorModelId &&
    previousTask.planningModelProvider === nextTask.planningModelProvider &&
    previousTask.planningModelId === nextTask.planningModelId &&
    previousTask.reviewLevel === nextTask.reviewLevel &&
    // FNXC:PlannerOversight 2026-07-04-00:00: repaint when the per-task oversight
    // override changes so the card-oversight-badge stays in sync (FN-7516).
    previousTask.plannerOversightLevel === nextTask.plannerOversightLevel &&
    // FNXC:PlannerOversight 2026-07-04-12:30: repaint when the board-supplied
    // `workflowBadge.workflowId` changes so the card re-fetches/re-reads the
    // correct workflow's effective oversight tier from the cache (FN-7516
    // code-review fix). `Task` itself has no `workflowId` field — workflow
    // selection lives in a separate `task_workflow_selection` table — so this
    // reuses the already-compared `workflowBadge` prop above rather than a
    // nonexistent task field.
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
    // FNXC:TaskRevert 2026-07-04-00:00: repaint the "Undo of <id>" footer chip
    // (FN-7555) when the revert-of marker changes.
    previousTask.sourceMetadata?.revertOf === nextTask.sourceMetadata?.revertOf &&
    previousTask.sourceParentTaskId === nextTask.sourceParentTaskId &&
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
      /*
      FNXC:PRBadgeStatusColor 2026-06-27-12:00:
      Multi-PR badge rendering depends on the same live PR fields as getPrBadgeModifierClass, so memoization must compare the full badge payload instead of only number/status to repaint draft and conflict color changes.
      */
      return areTaskBadgeInfosEqual(pr, nextPr);
    }) &&
    areTaskBadgeInfosEqual(previousTask.issueInfo, nextTask.issueInfo) &&
    // FNXC:GitHubTracking 2026-07-01-00:00: Context-menu tracking actions depend on githubTracking.enabled, so memoized cards must repaint when a PATCH enables tracking and remove the now-ineligible menu item.
    JSON.stringify(previousTask.githubTracking ?? null) === JSON.stringify(nextTask.githubTracking ?? null) &&
    JSON.stringify(previousTask.gitlabTracking ?? null) === JSON.stringify(nextTask.gitlabTracking ?? null) &&
    // FNXC:PlannerOversight 2026-07-04-00:00: FN-7531 exposes the transient, engine-populated
    // `plannerOverseerState` snapshot on the board payload; repaint the card whenever the
    // overseer state changes (idle/watching/steering/recovering/awaiting-confirmation) so a
    // consumer's badge stays live. FN-7516 owns the visual affordance/design; this task only
    // provides a minimal, type-safe, guarded read.
    JSON.stringify(previousTask.plannerOverseerState ?? null) === JSON.stringify(nextTask.plannerOverseerState ?? null)
  );
}

function TaskCardComponent({
  task,
  projectId,
  queued,
  onOpenDetail,
  onPlanningMode,
  planningWorkflowId,
  onOpenRefine,
  onOpenGroupModal,
  addToast,
  globalPaused,
  onUpdateTask,
  onRevertTask,
  onDeleteTask,
  onReviseTask,
  onPauseTask,
  onRetryTask,
  onOpenChatWithPrefill,
  onUnpauseTask,
  onResetTask,
  onDuplicateTask,
  onMergeTask,
  onOpenDetailWithTab,
  onOpenMission,
  onMoveTask,
  taskColumnFlags,
  taskMoveColumns,
  lastFetchTimeMs,
  fanout,
  prAuthAvailable,
  autoMergeEnabled = false,
  mergeStrategy = "direct",
  cardFieldDefs,
  workflowBadge,
  prNode,
  onOpenPullRequest,
  cliSessionState,
  nearDuplicateCanonicalInactive,
}: TaskCardProps) {
  const { t } = useTranslation("app");
  const { locale } = useLocaleFormat();
  const columnLabel = useColumnLabel();
  const [fileDragOver, setFileDragOver] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editDescription, setEditDescription] = useState(task.description || "");
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
  Column ROLES, resolved from this card's own workflow traits. Every `task.column ===
  "triage"` in this file previously asked "is this the planning lane?" by naming the
  Default workflow's id for it — which is live breakage the moment U11 lands, since the
  merged column keeps the id `todo` and DELETES `triage`. Each of those comparisons would
  silently become false and the affordance behind it would vanish from the board.

  `isIntakeColumn` is the planning/pre-work lane; `isHoldColumn` is the capacity-gated
  wait. Both survive the two merging into one. Flags come from the card's resolved
  workflow, so a renamed or custom workflow is correct with no change here.

  The move-progress prompt deliberately does NOT use these: it tests the move TARGET, not
  this card, and resolves that column's own flags at the call site.

  ONE fallback, not eight. `getTaskColumnFlags` (Column.tsx) returns undefined when the
  card's column is absent from the resolved metadata and is not the rendering column —
  the pre-load window and a card stranded in a vanished lane. Converting the eight sites
  to bare trait reads would have silently dropped every planning affordance in exactly
  those states, so the legacy ids survive HERE, once, as the no-metadata fallback, rather
  than scattered through the file. When flags are present — which is every card on a
  loaded board whose column its workflow declares — the traits decide and the U11 merge
  is a non-event. The fallback retires with the load window, not with this change.

  FNXC:WorkflowLifecycleColumns 2026-07-29-23:40 DELIBERATE-LITERAL: the fallback arm only.
  The trait path above is the live answer; this arm runs ONLY when the board has no resolved flags,
  and in that state there is nothing to resolve FROM. Deleting it does not remove a guard, it picks a
  different guess ("not intake") and silently drops planning affordances during first paint.
  */
  const isIntakeColumn = taskColumnFlags
    ? taskColumnFlags.intake === true
    : task.column === "triage";
  /* DELIBERATE-LITERAL — the no-metadata fallback for the pre-load window, matching `isIntakeColumn`
     directly above. Deleting it makes the card answer "no role" during first paint. */
  const isHoldColumn = taskColumnFlags
    ? taskColumnFlags.hold === true
    : task.column === "todo";

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-01:20 (fleet phase):
  THE OTHER FOUR ROLES, resolved once here rather than re-asked 39 times below.

  `taskColumnFlags` was already threaded into this component and already consumed by `canEdit` and
  `isTaskAgentActive`, but the terminal and mid-flight questions were still answered by comparing
  `task.column` to a literal — 39 times in one component, which is how a card ends up rendering as
  live work in one row and terminal in the next on a renamed board.

  Flags-first with the legacy id as the documented no-metadata fallback, identical in shape to the
  intake/hold pair above. Declared before the first `useState` initialiser because two of them are read
  in initial state.
  */
  const isWipColumn = isWipColumnRole(taskColumnFlags, task.column);
  const isReviewColumn = isReviewColumnRole(taskColumnFlags, task.column);
  const isCompleteColumn = isCompleteColumnRole(taskColumnFlags, task.column);

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-03:15:
  THE TIME-INDICATOR GATE IS A ROLE QUESTION, not membership of a hardcoded id set.

  `TIME_INDICATOR_COLUMNS` is `{in-progress, in-review, done}`, so a card in a renamed WIP, review or
  completion lane was rejected before its traits were consulted and rendered no elapsed time at all.
  #2996 fixed the SUBSCRIPTION for these cards — the memo that decides whether to join the shared
  ticker kept a pre-load answer — which made them eligible and still not visible, because this gate
  rejects them first. Both halves are needed; that PR's claim covered only one.

  The census could not point here: it counts COMPARISONS against legacy ids, and this is a Set
  literal, which is a DEFINITION. Same blind spot that hid `BLOCKER_ESCALATION_COLUMNS`.

  DELIBERATE-LITERAL — the legacy set stays as the no-flags fallback, so a card whose traits have not
  resolved (first paint, or a lane its workflow no longer declares) behaves exactly as before.
  */
  const showsTimeIndicator = taskColumnFlags
    ? isWipColumn || isReviewColumn || isCompleteColumn
    : TIME_INDICATOR_COLUMNS.has(task.column);

  const [isSaving, setIsSaving] = useState(false);
  const [showSteps, setShowSteps] = useState(
    isWipColumn ||
    (isIntakeColumn && task.steps.some(s => s.status === "done" || s.status === "skipped"))
  );
  const [missionTitle, setMissionTitle] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isPrCreateOpen, setIsPrCreateOpen] = useState(false);
  const [isAddressingPrFeedback, setIsAddressingPrFeedback] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [startPendingColumn, setStartPendingColumn] = useState<ColumnId | null>(null);
  const [lifecycleNowMs, setLifecycleNowMs] = useState(() => Date.now());

  /*
  FNXC:TaskCardDates 2026-07-24-11:02:
  FN-8561 requires compact lifecycle labels to change at the viewer's local
  midnight even when memoized task props are unchanged. One boundary timer per
  mounted card avoids stale "today" time labels and is always cleaned up.
  */
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setLifecycleNowMs(Date.now());
        schedule();
      }, millisecondsUntilNextLocalMidnight(new Date()));
    };
    schedule();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (startPendingColumn !== null && task.column !== startPendingColumn) {
      setStartPendingColumn(null);
    }
  }, [startPendingColumn, task.column]);

  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const touchOpenHandledRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  /*
  FNXC:TaskCardMenu 2026-07-10-12:00:
  Ref for the visible card actions (⋯) button, so the context-menu outside-pointerdown closer can
  ignore presses on the button itself — otherwise pointerdown would close the menu and the following
  click would immediately reopen it, breaking the toggle affordance.
  */
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [isInViewport, setIsInViewport] = useState(false);
  const { badgeUpdates, subscribeToBadge, unsubscribeFromBadge } = useBadgeWebSocket(projectId);
  const { agentsMap } = useAgentsMapCache(projectId);
  const { confirm, confirmWithSelect } = useConfirm();
  const retryWarningThreshold = useRetryWarning();
  const costBadge = useCostBadge();
  /*
  FNXC:TaskCardCostBadge 2026-07-31-23:39:
  Board cards must omit the optional spend chip entirely when the derived cost is unavailable, avoiding a dash-only badge or empty Promote row. Detail and analytics surfaces retain formatCost's guess-free “—” sentinel rather than fabricating a $0 value.
  */
  const cardCost = costBadge.enabled && hasTaskCost(task as TaskDetail)
    ? taskTotalCost(task as TaskDetail, costBadge.pricingOverrides)
    : null;
  const cardCostLabel = cardCost && !cardCost.unavailable && cardCost.usd !== null
    ? formatCost(cardCost.usd, false)
    : null;

  // Touch gesture detection refs
  const touchStartPosRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const hasTouchMovedRef = useRef(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const suppressNextCardClickRef = useRef(false);

  const isInteractiveTarget = useCallback((target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return !!target.closest("button, a, input, textarea, select, label, [role='button']");
  }, []);

  // Reset edit state when task changes
  useEffect(() => {
    setEditDescription(task.description || "");
  }, [task.id, task.description]);


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

  /*
   * FNXC:PlannerOversight 2026-07-17-15:50:
   * FN-8251 requires per-workflow cards to resolve inherited oversight with
   * their trusted selected `planningWorkflowId` when aggregate-only
   * `workflowBadge` metadata is absent. Prefer a task-specific aggregate ID;
   * normalize blank IDs; and fail closed for identity-less, pending, failed,
   * or malformed inherited resolution. The Eye is allowed only when effective
   * oversight is positively known active, while a valid task override remains
   * authoritative without a workflow fetch.
   */
  const workflowIdForOversight = normalizeWorkflowId(workflowBadge?.workflowId)
    ?? normalizeWorkflowId(planningWorkflowId);
  const workflowOversightCacheKey = workflowIdForOversight
    ? getWorkflowOversightCacheKey(workflowIdForOversight, projectId)
    : undefined;
  const [workflowOversightState, setWorkflowOversightState] = useState<WorkflowOversightResolution>({ level: undefined, resolved: false });
  useEffect(() => {
    if (!workflowIdForOversight || !workflowOversightCacheKey) {
      setWorkflowOversightState({ level: undefined, resolved: false });
      return;
    }

    const workflowId = workflowIdForOversight;
    const key = workflowOversightCacheKey;
    let cancelled = false;
    const resolveCurrentLevel = () => {
      setWorkflowOversightState({
        level: undefined,
        resolved: false,
        workflowCacheKey: key,
        settingsRevision: getWorkflowSettingValuesRevision(workflowId, projectId),
      });
      void loadWorkflowOversightEffectiveLevel(workflowId, projectId).then((resolution) => {
        if (!cancelled && resolution.settingsRevision === getWorkflowSettingValuesRevision(workflowId, projectId)) {
          setWorkflowOversightState({ ...resolution, workflowCacheKey: key });
        }
      });
    };
    const handleWorkflowSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowSettingValuesUpdatedDetail>).detail;
      if (detail?.workflowId === workflowId && detail.projectId === projectId) resolveCurrentLevel();
    };

    resolveCurrentLevel();
    window.addEventListener(WORKFLOW_SETTING_VALUES_UPDATED_EVENT, handleWorkflowSettingsUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(WORKFLOW_SETTING_VALUES_UPDATED_EVENT, handleWorkflowSettingsUpdated);
    };
  }, [workflowIdForOversight, workflowOversightCacheKey, projectId]);
  // FNXC:PlannerOversight 2026-07-17-15:50: Switching a memoized card between
  // workflows must fail closed in the render before its effect resets state;
  // an active tier resolved for the prior workflow cannot authorize this Eye.
  const currentWorkflowOversightState = workflowOversightState.workflowCacheKey === workflowOversightCacheKey
    && workflowOversightState.settingsRevision === (workflowIdForOversight
      ? getWorkflowSettingValuesRevision(workflowIdForOversight, projectId)
      : undefined)
    ? workflowOversightState
    : { level: undefined, resolved: false };
  const workflowOversightEffectiveLevel = currentWorkflowOversightState.level;
  const workflowOversightResolved = currentWorkflowOversightState.resolved;

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
    if (suppressNextCardClickRef.current) {
      suppressNextCardClickRef.current = false;
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
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
        longPressStartRef.current = null;
      }
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      longPressStartRef.current = null;
    }
    if (contextMenuPosition) {
      e.preventDefault();
      touchStartPosRef.current = null;
      hasTouchMovedRef.current = false;
      return;
    }
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
  }, [contextMenuPosition, handleClick, isInteractiveTarget]);

  const handleDepClick = useCallback(async (e: React.MouseEvent, depId: string) => {
    e.stopPropagation(); // Prevent card click
    try {
      const detail = await fetchTaskDetail(depId, projectId);
      onOpenDetail(detail);
    } catch {
      addToast(t("tasks.loadDependencyFailed", "Failed to load dependency {{depId}}", { depId }), "error");
    }
  }, [onOpenDetail, addToast]);

  const isDoneColumn = isCompleteColumn;
  const visualStatus = isDoneColumn ? "done" : task.status;
  const hasPendingRecovery = hasPendingAutomaticRecovery(task, lastFetchTimeMs);
  const isExternalBlocked = !isDoneColumn && isTaskExternallyBlocked(task);
  const isFailed = !isDoneColumn && task.status === "failed" && !hasPendingRecovery;
  const isPaused = !isDoneColumn && !isExternalBlocked && (task.paused === true || task.userPaused === true);
  const isTriageDuplicateDecision = isPaused
    && task.pausedReason === "duplicate-decision-required"
    && task.sourceMetadata?.duplicateSource === "triage-marker"
    && typeof task.sourceMetadata?.nearDuplicateOf === "string";
  const pausedByAgent = Boolean(!isDoneColumn && task.paused && task.pausedByAgentId);
  const normalizedPriority = normalizeTaskPriorityValue(task.priority);
  const showPriorityBadge = normalizedPriority !== DEFAULT_TASK_PRIORITY;
  const PriorityBadgeIcon = getPriorityIcon(normalizedPriority);
  const stalledReview = getStalledReviewSignal(task);
  const showStalledReview = Boolean(stalledReview && isReviewColumn && !isPaused);
  const hasInReviewStall = shouldShowInReviewStallBadge(task, taskColumnFlags);
  /*
  FNXC:TaskCardPlanReviewBadge 2026-07-11-12:05:
  FN-7831 requires the card header to show a distinct "Reviewing" badge while the optional `plan-review` workflow step is actively running, even while the card remains in Planning/`triage`. Use the shared predicate so TaskCard stays in sync with ListView.

  FNXC:TaskCardOptionalGateBadge 2026-07-21-22:30:
  Extend the same additive header-badge pattern to Code Review / Browser Verification while the card is in In-review. Lane-owned optional gates never appear in the WIP bullet list; they surface only as this badge while running.
  */
  const planReviewRunning = useMemo(
    () => isPlanReviewRunning(task),
    [task.steps, task.enabledWorkflowSteps, task.workflowStepResults],
  );
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-00:40 (partial-supply seam, caught by the gate):
  `getRunningOptionalGateBadge` takes resolved flags and BOTH ListView call sites supply them; this
  one did not, so on a renamed board the badge answered from legacy ids here and from the real column
  two components over. The seam check only began reporting this once it looked per-call-site instead
  of accepting one supplier for the whole seam.

  `taskColumnFlags` belongs in the deps: this repo has no `react-hooks/exhaustive-deps` rule, so a
  memo that reads flags but does not list them is invisible to lint and would keep the first-paint
  (undefined) answer after the flags resolve — re-creating the same legacy-fallback bug through
  staleness instead of omission.
  */
  const optionalGateBadge = useMemo(
    () => getRunningOptionalGateBadge(task, taskColumnFlags),
    [task.column, task.steps, task.enabledWorkflowSteps, task.workflowStepResults, taskColumnFlags],
  );
  // CLI agent session badges (U11) — distinct from staleness/stall badges.
  const cliWaitingOnInput = cliSessionState?.agentState === "waitingOnInput";
  const cliNeedsAttention = cliSessionState?.agentState === "needsAttention";
  const stallCopy = task.inReviewStall
    ? getInReviewStallCopy(task.inReviewStall, {
      mergeRetries: task.mergeRetries,
      maxAutoMergeRetries: MAX_AUTO_MERGE_RETRIES,
    })
    : undefined;
  const hasStalePausedReview = shouldShowStalePausedReviewBadge(task, taskColumnFlags);
  const stalePausedReviewCopy = task.stalePausedReview ? getStalePausedReviewCopy(task.stalePausedReview) : undefined;
  const hasTaskAgeStaleness = shouldShowTaskAgeStalenessBadge(task);
  const taskAgeStalenessCopy = getTaskAgeStalenessCopy(task.ageStaleness);
  /*
  FNXC:PlanReviewReplan 2026-07-15-11:09:
  Awaiting-approval on triage is the human plan gate. Legacy release-authorization rows still
  use the generic badge (FN-7732). plan-review-replan-cap must read distinctly so operators
  know approval is required because Plan Review exhausted automatic REVISE replans without
  converging — Approve keeps the current PROMPT.md; Reject regenerates.
  */
  const isPlanReviewReplanCapApproval = isReviewBudgetExhaustedApproval(task);
  const isPlanningLane = isPreImplementationColumnRole(taskColumnFlags, task.column);
  const isAwaitingApproval = isTaskAwaitingPlanApproval(task, isPlanningLane);
  const isAwaitingInput = task.status === "awaiting-user-input";
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (PR #2566 review — greptile):
  Pass the card's column traits. Without them the planner-lane clause falls back to the
  legacy ids, so a status-null card on the MERGED planning lane (id `todo`, intake+hold)
  is not recognised as having fresh planner activity: the pulsing Planning state, the
  optional-gate activity and the column's executing count all read idle. Threading
  ListView alone left this path — the board cards — still broken.
  */
  const isAgentActive = isTaskAgentActive(task, { globalPaused, queued, columnFlags: taskColumnFlags });
  /*
  FNXC:TaskCardOptionalGateBadge 2026-07-21-22:30:
  Match FN-8055: optional-gate badges pulse only while the card is agent-active (queue/pause gates suppress the badge).
  */
  const showOptionalGateBadge = Boolean(optionalGateBadge) && isAgentActive;
  /*
  FNXC:CodingIdeasWorkflow 2026-07-21-22:18:
  Ready is the idle capacity-hold signal for Coding (Ideas) Todo cards that already have steps and no task.status. Plan Review (and any other agent-active work) also runs in Todo with status often cleared to null first, so Ready must suppress while plan-review is running or the card is agent-active — otherwise operators see both Ready and Reviewing on the same card.
  */
  /*
  FNXC:CodingIdeasWorkflow 2026-07-26-15:30:
  Which cap an idle Todo card is waiting on comes from the server's `awaitingPlanning` (derived from
  PROMPT.md seed-ness by the SAME `isTaskAwaitingPlanning` predicate triage's todo-discovery uses),
  because the client cannot read PROMPT.md. The old `steps.length` proxy disagreed with the engine in
  both directions: a real spec that parsed to zero steps read as "Queued to plan" while the scheduler
  was already treating it as a WIP-slot candidate, and a re-seeded card still carrying steps from a
  previous pass read as "Ready" while triage was about to plan it.

  The step-count heuristic remains the FALLBACK, not a second opinion: SSE task payloads are not
  enriched, so a status-only live update or an older server leaves the field absent, and a card with
  no steps is unplanned in the overwhelmingly common case. Deriving both badges from this one value
  makes them strict complements — exactly one shows — instead of relying on the step count to keep
  two independent conditions disjoint.
  */
  const awaitingPlanning = task.awaitingPlanning ?? ((task.steps?.length ?? 0) === 0);
  const showIdleTodoBadge = !isPaused
    && isHoldColumn
    && !visualStatus
    && !planReviewRunning
    && !isAgentActive;
  const showReadyBadge = showIdleTodoBadge && !queued && !awaitingPlanning;
  /*
  FNXC:CodingIdeasWorkflow 2026-07-25-12:05:
  "Queued to plan" is the exact complement of Ready: same idle-in-Todo conditions, but the card has
  NO steps yet, so it is unplanned and waiting for a PLANNING slot rather than a WIP slot. Without
  it a started card that the concurrency pool has not admitted is visually identical to a card
  nothing is going to happen to — the throttle was only observable in the engine log
  ("Plan throttled by running-agent cap|global semaphore"), which is why a busy pool read as a bug.

  Three Todo states are now distinguishable: planning in flight (the "planning" status badge),
  unplanned and waiting for a planning slot (this badge), planned and waiting for a WIP slot
  (Ready).

  FNXC:CodingIdeasWorkflow 2026-07-26-15:30:
  Both badges now derive from the single `awaitingPlanning` value above, so "exact complement" is
  structural rather than a property of the step count that two independent conditions had to agree on.
  */
  const showQueuedToPlanBadge = showIdleTodoBadge && !queued && awaitingPlanning;
  /*
  FNXC:TaskStatusBadge 2026-08-28-21:24:
  Idle-hold tooltips must state the release-gate reason the server actually observed rather than asserting capacity for every wait. SSE and enrichment-cap rows can omit the verdict, so the existing generic planning-slot copy remains the fallback.
  */
  const queuedToPlanTitle = task.releaseGate?.reason === "plan-review-pending"
    ? t(
        "tasks.queuedToPlanPlanReviewTitle",
        "Plan Review has not finished yet — implementation starts once the plan passes review.",
      )
    : task.releaseGate?.reason === "needs-replan"
      ? t(
          "tasks.needsReplanQueuedTitle",
          "Waiting to revise the plan — the revision starts when a planning slot frees up.",
        )
      : t(
          "tasks.queuedToPlanTitle",
          "Waiting for a planning slot — planning starts when an agent slot frees up",
        );
  /*
  FNXC:TaskCardMovement 2026-08-19-18:32:
  Native task movement is intentionally absent from cards. File drops remain below because
  attaching files is a separate card interaction, while task transitions stay in the context menu.
  */

  // Check if this card can be edited inline
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-00:15 (U12 — R8 drift conversion):
  THE ASYMMETRY: this read a hardcoded `{triage, todo}` set with no trait path, while
  TaskDetailModal resolved the SAME affordance from column traits (U10/R8). So on a renamed board an
  operator could edit a task's title in the detail modal but the pencil was missing from its card,
  and after #2515 the `triage` half was dead weight. `taskColumnFlags` was already in scope here —
  the card simply never asked.
  */
  const canEdit = isFieldEditableColumnRole(taskColumnFlags, task.column) && !isAgentActive && !isPaused && !queued && onUpdateTask;
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
    && !isCompleteColumn
    && nearDuplicateCanonicalInactive !== true;
  /**
   * FNXC:TaskRevert 2026-07-04-00:00:
   * FN-7555 forward affordance: an AI-undo task (`sourceMetadata.revertOf` set by
   * `createAiUndoTask`) shows a compact "Undo of <sourceId>" footer chip regardless
   * of this card's own column, mirroring the detail view's provenance line. The
   * reverse ("source has an open undo task") chip is intentionally NOT rendered
   * here — TaskCard does not receive the full `tasks` list, so a per-card reverse
   * scan is unavailable; that direction is covered by TaskDetailModal only.
   */
  const revertOfId = getRevertOfId(task.sourceMetadata, task.sourceParentTaskId, task.sourceType);
  const showUndoOfChip = Boolean(revertOfId);
  /*
  FNXC:RefinementTitle 2026-07-26-20:10:
  A refinement card is now titled by the operator's feedback rather than "Refinement: <parent>",
  so the title no longer announces what the card IS. This chip carries that provenance instead:
  an icon plus the parent id, so a stack of ten refinements of one task stays both individually
  readable (distinct titles) and recognizable as refinements (identical chip, distinct id).
  Gated on `sourceParentTaskId` because the chip's whole value is naming the parent — a
  refinement row with no resolvable parent would render a chip that answers nothing.
  */
  const refinesParentId = task.sourceType === "task_refine" ? task.sourceParentTaskId : undefined;
  const showRefinesChip = Boolean(refinesParentId);
  /*
   * FNXC:TaskRevert 2026-07-16-00:00:
   * FN-8066 makes the source-task revert marker visible only in its completed
   * surfaces. TaskCard serves both board and list views, so this one predicate
   * preserves the Done invariant without adding a view-specific badge.
   */
  const showRevertedChip = isTaskReverted(task.sourceMetadata)
    && isCompleteColumn;
  const branchMetadata = useMemo(() => getVisibleTaskCardBranches(task), [task.id, task.branch, task.baseBranch]);
  const hasBranchMetadata = Boolean(branchMetadata.branch || branchMetadata.baseBranch);
  const isAgentCreated = isAgentCreatedTask(task);
  const sourceAgentName = getSourceAgentName(task, agentsMap);
  const agentCreatedVisibleLabel = sourceAgentName
    ? t("tasks.createdByAgentShort", "by {{name}}", { name: abbreviateBadge(sourceAgentName, 15) })
    : t("tasks.agentLabel", "Agent");
  const agentCreatedTitle = sourceAgentName
    ? t("tasks.createdByAgentNamed", "Created by agent: {{name}}", { name: sourceAgentName })
    : t("tasks.createdByAgent", "Created by agent");
  const assignedAgentNameFromMap = getResolvedAgentNameFromMap(task.assignedAgentId, agentsMap);
  const assignedAgentNameFromCache = task.assignedAgentId ? agentNameCache.get(task.assignedAgentId) ?? null : null;
  const resolvedAssignedAgentName = assignedAgentNameFromMap ?? assignedAgentNameFromCache ?? agentName;
  const assignedAgentBadgeLabel = resolvedAssignedAgentName ?? task.assignedAgentId ?? "";
  const isAgentNameLoading = Boolean(task.assignedAgentId && !resolvedAssignedAgentName);
  const shouldShowCreatedAgentBadge = isAgentCreated && !(
    task.assignedAgentId
    && isSameAgentIdentity(
      task.assignedAgentId,
      task.sourceAgentId,
      resolvedAssignedAgentName,
      sourceAgentName,
    )
  );
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
  /*
  FNXC:TaskCardWorkflowProgress 2026-07-21-22:26:
  In-progress card progress is WIP implementation only. Plan Review (Todo) and Code Review / other review-lane gates must not appear as checklist rows or inflate completed/total while the card is in In progress; badges still use full progress helpers (isPlanReviewRunning / running step labels).
  */
  const unifiedProgress = useMemo(
    () => getUnifiedTaskProgress(task, { scope: isReviewColumn ? "full" : "implementation" }),
    [isReviewColumn, task.column, task.steps, task.enabledWorkflowSteps, task.workflowStepResults],
  );
  /*
  FNXC:TaskCardProgress 2026-06-29-02:26:
  Operators need to see active step work on the card before it becomes `done`. Keep the completed count strict, but surface `in-progress` task steps and running workflow checks as an active badge so card progress does not look stale while execution is underway.
  */
  const activeProgressCount = useMemo(
    () => unifiedProgress.items.filter((item) => item.status === "in-progress" || item.status === "running").length,
    [unifiedProgress.items],
  );
  /*
  FNXC:TaskCardWorkflowProgress 2026-07-08-hh:mm:
  FN-7676 — cards in the Planning/`triage` column must not surface the steps breakdown (progress bar, active badge, step-count toggle, expandable list); enumerated implementation steps are premature planning artifacts, not execution progress. The affordance now appears only after the task leaves Planning (`in-progress` / `executing`), matching `ListView.shouldShowTaskProgress`. FN-7831 adds a separate header "Reviewing" badge for a running Plan Review, but the progress breakdown itself remains hidden in Planning.
  */
  /*
  FNXC:TaskCardWorkflowProgress 2026-08-25-01:10:
  The review lane shows its breakdown too. FN-7676 hid it in Planning because enumerated steps are a
  premature planning artifact there — that reasoning does not extend to in-review, where a
  review-column workflow such as builtin:coding-ideas-v2 runs Verification, Documentation & Delivery
  and Code Review as real, advancing work. The card already resolves the FULL pipeline once it
  reaches that lane; this gate then suppressed the rendering of what it had just computed, so the
  operator saw nothing for the stage those gates were promoted into. Resolved by TRAIT, not by the
  hardcoded `in-review` id, so a renamed board behaves the same.
  */
  /*
  FNXC:TaskCardWorkflowProgress 2026-08-25-11:40:
  The review lane shows its stage as a BADGE, not a step list. A review-column workflow has few
  milestones in a fixed order (Code Review -> Documentation -> merge), so the running-gate badge
  already answers "where is this card", and a list of two rows plus every finished implementation
  step is noise on a board.
  It also removes a whole failure mode: the list is built from `task.enabledWorkflowSteps`, which is
  frozen on the card at planning time, so a card planned before a workflow changed rendered a
  milestone that no longer exists as permanently `pending`. No list, no ghost.
  Cost, stated: a non-blocking gate that failed is no longer visible from the board — open the card.
  Blocking failures still move the card back to in-progress, which is visible.
  */
  const showProgressSection =
    unifiedProgress.total > 0
    && (task.status === "executing" || isWipColumn);

  /*
  FNXC:BoardPerformance 2026-07-26-09:46:
  This card used to own a `window.setInterval` for its live elapsed-time indicator, so a 60-card board
  ran 60 independent 30s timers that kept waking the tab even while backgrounded. Mobile browsers
  (iOS Safari, iOS PWA, Chrome Android) discard a backgrounded page that never goes idle, which is
  what produced the white-splash reload operators saw on returning to the dashboard. The card now
  DERIVES whether it needs a live indicator and subscribes to the single shared ticker in
  `useLiveTimeTicker` (one interval process-wide, suspended while hidden, immediate tick on return).
  Cards that are ineligible must NOT subscribe: eligibility is exactly the set of early-returns the
  old effect used, so cadence, formatting, and which cards animate are unchanged.
  */
  const wantsLiveTimeIndicator = useMemo(() => {
    if (!isWipColumn && !isReviewColumn) {
      return false;
    }

    const merging = task.status != null && ACTIVE_MERGE_STATUSES.has(task.status);
    const nowMs = Date.now();

    if (isWipColumn) {
      const endToEndMs = getTaskEndToEndDurationMs(task, nowMs, taskColumnFlags);
      const elapsedMs = getInProgressElapsedMs(task, nowMs);
      const instrumentedMs = getInstrumentedDurationMs(task, nowMs);
      if (endToEndMs == null && elapsedMs == null && instrumentedMs == null) {
        return false;
      }
    }

    if (!merging && isReviewColumn) {
      const endToEndMs = getTaskEndToEndDurationMs(task, nowMs);
      const instrumentedMs = getInstrumentedDurationMs(task, nowMs);
      if (endToEndMs == null && instrumentedMs == null) {
        return false;
      }
    }

    return true;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:40:
  THE LANE ROLES BELONG IN THIS LIST, or the card never subscribes on a renamed board.

  `isWipColumn`/`isReviewColumn` derive from the `taskColumnFlags` PROP, which arrives after first
  paint — the board resolves workflow traits asynchronously. The first computation therefore runs
  with the flags undefined, the role helpers fall back to the legacy ids, and on a renamed board that
  answers false. When the flags arrive `task.column` is unchanged, so a list of `task.*` fields alone
  never recomputes and the pre-load answer sticks: no live elapsed-time indicator, for the life of
  the mount.

  A legacy board hid this completely, because there the fallback already answers true on the first
  paint and the stale list costs nothing.

  This repo has no `react-hooks/exhaustive-deps` rule, so the list is maintained by hand and a
  disable directive for that rule fails CI.
  */
  }, [task.column, task.status, task.columnMovedAt, task.updatedAt, task.workflowStepResults, task.timedExecutionMs, task.firstExecutionAt, task.cumulativeActiveMs, task.executionStartedAt, task.executionCompletedAt, isWipColumn, isReviewColumn, taskColumnFlags]);

  const timeIndicatorNowMs = useLiveTimeTicker(wantsLiveTimeIndicator);

  const timeIndicator = useMemo(() => {
    if (!showsTimeIndicator) {
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

    if (isWipColumn) {
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

    const completionMs = getInReviewCompletionMs(task, taskColumnFlags);
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
  /* FNXC:WorkflowResolvedColumns 2026-07-31-23:59: `taskColumnFlags` joins the deps because this memo
     now READS it. Flags arrive asynchronously (the board resolves workflows after first paint), so a
     card that renders before they load and re-renders after would otherwise keep the pre-flag answer
     — the memo's inputs would be unchanged. This repo has no `react-hooks/exhaustive-deps` rule, so
     nothing would have flagged the omission. */
  }, [task.column, task.status, task.columnMovedAt, task.timedExecutionMs, task.updatedAt, task.workflowStepResults, task.log, task.firstExecutionAt, task.cumulativeActiveMs, task.cumulativePlanningMs, task.planningStartedAt, task.executionStartedAt, task.executionCompletedAt, timeIndicatorNowMs, taskColumnFlags]);

  const lifecycleDates = useMemo(() => {
    const created = formatCompactLifecycleDate(task.createdAt, locale, new Date(lifecycleNowMs));
    const completionSource = task.executionCompletedAt ?? task.archivedAt;
    const completed = isCompleteColumn
      ? formatCompactLifecycleDate(completionSource, locale, new Date(lifecycleNowMs))
      : null;
    return { created, completed };
  /*
  The board resolves workflow traits after first paint, so the first computation runs with the flags
  undefined and the role helpers fall back to the legacy ids. On a renamed board that answers false,
  `completed` is null, and the "Completed <date>" line never renders. When the flags arrive nothing in
  the old list had changed — every entry was a `task.*` field, `locale`, or `lifecycleNowMs`.

  WHY THE SWEEP IN #3001 CALLED THIS COVERED: `lifecycleNowMs` does change, so the memo does
  eventually recompute — but its timer fires at the viewer's LOCAL MIDNIGHT (see the
  `millisecondsUntilNextLocalMidnight` effect). A dependency that turns over once a day is not
  coverage for a value that must be right on first paint; the card shows no completion date for the
  rest of the session.

  A default board hides it: `column === "done"` is already true before the flags land.
  */
  }, [task.createdAt, task.executionCompletedAt, task.archivedAt, task.column, locale, lifecycleNowMs, isCompleteColumn]);

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
  const isActiveColumn = isWipColumn || isReviewColumn;
  const stepVersion = useMemo(
    () => task.steps.map((s) => `${s.name}:${s.status}`).join("|"),
    [task.steps],
  );
  const mergeSignature = useMemo(() => {
    if (!isCompleteColumn) {
      return undefined;
    }

    const landedFilesCount = task.mergeDetails?.landedFiles?.length ?? "";
    const filesChanged = task.mergeDetails?.filesChanged ?? "";
    return `${landedFilesCount}:${filesChanged}`;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:25:
  `isCompleteColumn` BELONGS IN THIS LIST — it derives from the async `taskColumnFlags` prop.

  Without it the signature is computed once, during the pre-load render where the flags are undefined
  and the role helper falls back to the legacy id. On a renamed board that answers false, so the key
  is `undefined`; and for a card already merged when the board loaded, neither `mergeDetails` field
  changes afterwards either, so nothing ever recomputes and `useTaskDiffStats` loses the signal that
  a merge changed what the card should show.

  A legacy board hid it: `column === "done"` is already true on the first paint.
  */
  }, [task.column, task.mergeDetails?.landedFiles?.length, task.mergeDetails?.filesChanged, isCompleteColumn]);

  // Viewport-gated diff stats fetching - only fetch when card is visible
  const { stats: diffStats, loading: diffLoading } = useTaskDiffStats(
    task.id,
    task.column,
    task.mergeDetails?.commitSha,
    projectId,
    {
      enabled: isInViewport,
      // FNXC:WorkflowResolvedColumns 2026-07-31-03:30: the card already resolved these; the hook needs
      // them so its done/active decision is a role question rather than an id comparison.
      columnFlags: taskColumnFlags,
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

  const effectiveAutoMerge = resolveEffectiveAutoMerge({ autoMerge: task.autoMerge }, { autoMerge: autoMergeEnabled ?? false });
  /*
   * FNXC:PlannerOversight 2026-07-04-12:30:
   * FN-7516 card-surface slice of the planner-oversight feature: show a read-only
   * effective oversight-level badge. Reuse the FN-7515/FN-7508 resolver verbatim
   * rather than re-deriving tier precedence here.
   *
   * Code review flagged (round 1) that always passing `undefined` for the
   * workflow tier made every task without a per-task override show
   * "Autonomous recovery", even when the task's WORKFLOW was explicitly
   * configured to Off/Observe/Steer. Fixed: `workflowOversightEffectiveLevel`
   * (see the effect above) is the workflow's real effective
   * `plannerOversightLevel` setting value, fetched/cached per
   * `(workflowId, projectId)` via the existing workflow setting-values route
   * — this is the true workflow tier, not a guess. The resolver keeps its own
   * default-fallback policy: only when NEITHER the task override NOR the
   * workflow tier resolves does it fall back to the schema default
   * ("autonomous", `DEFAULT_PLANNER_OVERSIGHT_LEVEL"`).
   *
   * Code review flagged (round 2) that the fallback above still fires WHILE
   * the workflow-tier fetch is in flight (or after it fails), because an
   * in-flight/unresolved `workflowOversightEffectiveLevel` is `undefined` —
   * indistinguishable, to the resolver, from "the workflow has no oversight
   * setting". That rendered the schema default badge for a beat (or
   * permanently on fetch failure) before the true workflow tier arrived.
   * Fix: a known per-task override renders immediately (it's synchronous,
   * from the task payload); otherwise the badge is withheld entirely until
   * `workflowOversightResolved` is true, so an inherited task never shows a
   * default/guessed level. Only an effective level that resolves to "off"
   * renders no badge either (no empty shell) — see the
   * `hasCardMetaBadges`/render guard below.
   *
   * FN-7539: the round-2 fix above still showed the badge on virtually every
   * card, because a task with no per-task override and no explicit
   * non-default workflow tier resolves to the schema default
   * (`DEFAULT_PLANNER_OVERSIGHT_LEVEL`, "autonomous") — and that default was
   * still treated as "resolved" and rendered. An inherited default is not
   * meaningfully-configured oversight, so it must not surface a per-card
   * badge. Narrowed: suppress the badge when the effective level equals the
   * schema default AND there is no explicit per-task override — i.e. the
   * default was reached purely by inheritance (no override, no non-default
   * workflow tier). An EXPLICIT per-task override of "autonomous" still
   * renders the badge (explicit intent is preserved, not treated as
   * inherited default), and a workflow tier that explicitly resolves to
   * "autonomous" also renders nothing, matching the inherited-default case.
   */
  const hasTaskOversightOverride = isPlannerOversightLevelValue(task.plannerOversightLevel);
  const effectiveOversightLevel: PlannerOversightLevel = resolveEffectivePlannerOversightLevel(
    task.plannerOversightLevel,
    workflowOversightEffectiveLevel,
  );
  const isInheritedDefaultOversightLevel =
    !hasTaskOversightOverride && effectiveOversightLevel === DEFAULT_PLANNER_OVERSIGHT_LEVEL;
  const showOversightBadge =
    (hasTaskOversightOverride || workflowOversightResolved) &&
    effectiveOversightLevel !== "off" &&
    !isInheritedDefaultOversightLevel;

  /*
   * FNXC:PlannerOversight 2026-07-18-01:30:
   * FN-8255 requires the transient Eye badge and its header-wrapper gate to
   * reuse the same meaningfully-configured gate as the level badge. A workflow
   * declaration-default autonomous tier with no explicit task override is not
   * active card oversight, so a stale non-idle snapshot must not show an icon
   * or leave an empty header-badge shell; `showOversightBadge` preserves the
   * FN-7539 inherited-default suppression and the FN-8239/FN-8251 fail-closed
   * resolution guards.
   */
  const plannerOverseerState = task.plannerOverseerState;
  const showPlannerOverseerStateBadge = Boolean(
    showOversightBadge
    && plannerOverseerState
    && plannerOverseerState.state !== "idle"
    && plannerOverseerState.oversightLevel !== "off",
  );

  /*
   * FNXC:PlannerOversight 2026-07-04-HH:MM:
   * FN-7542 removed the active-overseer-state ("Executor") chip that used to
   * render here as unwanted per-card noise — it fired on nearly every
   * in-progress card. The oversight-level badge (`showOversightBadge` above)
   * is unaffected and continues to render per its own gate.
   */
  const showCreatePrQuickAction =
    isReviewColumn
    && !effectiveAutoMerge
    && !livePrInfo
    && prAuthAvailable === true
    && !isPaused
    && !isFailed
    && !queued;
  const showAddressPrFeedbackAction = canStartPrFeedbackAddressing(task, taskColumnFlags);
  const metaRowVisible =
    (task.dependencies?.length ?? 0) > 0
    || Boolean(task.blockedBy)
    || Boolean(task.overlapBlockedBy)
    || Boolean(fanout && fanout.totalCount > 0);
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8):
  `manualIntake`, not `intake && column !== "triage"`. The old form used a hardcoded id to
  stand in for a fact the payload did not carry: an intake column that does NOT auto-triage.
  It also inverts under U11 — `triage` is deleted, so `column !== "triage"` becomes
  vacuously true and Start would appear on every planning card. The flag is derived
  server-side from the intake trait's `autoTriage: false` config.
  */
  const showStartAction = taskColumnFlags?.manualIntake === true && Boolean(onMoveTask);
  /*
  FNXC:CodingIdeasWorkflow 2026-07-04-12:30:
  The Start action promotes a card out of a manual intake into the workflow's first working column. Derive the target from the ordered workflow columns instead of hard-coding "todo" so a workflow whose intake feeds a differently-named stage transitions correctly. Falls back to "todo" when the column metadata is unavailable (e.g. the all-workflows board aggregate).
  */
  const startTargetColumn: ColumnId = useMemo(() => {
    const next = taskMoveColumns?.find(
      (c) => c.id !== task.column && !c.flags?.intake && !c.flags?.hiddenFromBoard,
    );
    return (next?.id ?? "todo") as ColumnId;
  }, [taskMoveColumns, task.column]);
  const shouldRenderActionRow = showCreatePrQuickAction || showAddressPrFeedbackAction || showStartAction;

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
      addToast(t("tasks.duplicateDismissed", "Duplicate flag cleared for {{taskId}}", { taskId: task.id }), "success");
    } catch (err) {
      addToast(t("tasks.duplicateDismissFailed", "Failed to clear the duplicate flag for {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(err) }), "error");
    }
  }, [addToast, onUpdateTask, task.id]);


  /*
  FNXC:TaskRevert 2026-07-05-00:00 (FN-7525):
  Revertable guard: a card is only offered a Revert affordance when it sits in
  Done and it has a landed commit to revert. Absent `mergeDetails` (no
  merge ever recorded, e.g. a no-op/no-commits-expected task) means there is
  nothing to revert — treat it as not-revertable rather than erroring at click
  time. This mirrors the parent FN-7501 issue's "undo a change" framing: only
  tasks that actually changed the tree are revertable.
  */
  const isRevertable = isCompleteColumn && Boolean(task.mergeDetails?.commitSha);

  /*
  FNXC:TaskRevert 2026-07-05-00:00 (FN-7525):
  Revert click handler: calls the API in "auto" mode (git-first, AI-undo
  fallback on conflict/unsupported). Never silently AI-forks a `needsHuman`
  result (e.g. autoMerge-off) — that is surfaced as an informational toast so a
  human can decide, per the FN-7524 route contract. The SOURCE task's column is
  never mutated here as a side effect of a revert.
  */
  const handleRevertClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onRevertTask) return;

    void onRevertTask(task.id, { mode: "auto" }).then(async (result) => {
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
        });
        if (!confirmed) return;

        try {
          const aiResult = await onRevertTask(task.id, { mode: "ai" });
          if (aiResult.mode === "ai") {
            addToast(aiResult.alreadyOpen
              ? t("tasks.revertAlreadyOpen", "An undo task is already open: {{id}}", { id: aiResult.createdTaskId })
              : t("tasks.revertAiCreated", "Created undo task {{id}}", { id: aiResult.createdTaskId }), "success");
          }
        } catch (aiErr) {
          addToast(getErrorMessage(aiErr), "error");
        }
        return;
      }

      addToast(t("tasks.revertFailed", "Failed to revert {{taskId}}", { taskId: task.id }), "error");
    }).catch((err) => {
      addToast(getErrorMessage(err), "error");
    });
  }, [addToast, confirm, onRevertTask, t, task.id]);

  const handleTaskActionRevert = useCallback(() => {
    handleRevertClick({ stopPropagation() {} } as React.MouseEvent<HTMLButtonElement>);
  }, [handleRevertClick]);

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

  const handleTaskActionDelete = useCallback(() => {
    void handleDeleteClick({ stopPropagation() {} } as React.MouseEvent<HTMLButtonElement>);
  }, [handleDeleteClick]);

  const handleTaskActionRetry = useCallback(async () => {
    if (!onRetryTask || isRetrying) return;
    const copy = resolveRetryStageCopy(t, taskColumnFlags, task.column);
    const confirmed = await confirm({
      title: copy.confirmTitle,
      message: copy.confirmMessage,
      confirmLabel: copy.confirmLabel,
      cancelLabel: t("common.cancel", "Cancel"),
      danger: true,
    });
    if (!confirmed) return;
    setIsRetrying(true);
    try {
      await onRetryTask(task.id);
      addToast(copy.successMessage, "success");
    } catch (err) {
      addToast(t("tasks.retryFailed", "Failed to retry {{taskId}}: {{error}}", { taskId: task.id, error: getErrorMessage(err) }), "error");
    } finally {
      setIsRetrying(false);
    }
  }, [addToast, confirm, isRetrying, onRetryTask, t, task.column, task.id, taskColumnFlags]);

  const handleTaskActionTogglePause = useCallback(async () => {
    try {
      if (isPaused) {
        if (!onUnpauseTask) return;
        await onUnpauseTask(task.id);
        addToast(t("taskDetail.pause.unpaused", "Unpaused {{id}}", { id: task.id }), "success");
      } else {
        if (!onPauseTask) return;
        await onPauseTask(task.id);
        addToast(t("taskDetail.pause.paused", "Paused {{id}}", { id: task.id }), "success");
      }
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [addToast, isPaused, onPauseTask, onUnpauseTask, task.id, t]);

  const handleTaskActionReset = useCallback(() => {
    if (onResetTask) setShowResetDialog(true);
  }, [onResetTask]);

  const handleTaskActionDuplicate = useCallback(async () => {
    if (!onDuplicateTask) return;
    await runDuplicateTaskAction({
      taskId: task.id,
      t,
      addToast,
      confirmWithSelect,
      confirm,
      duplicateTask: onDuplicateTask,
      loadBoardWorkflows: () => fetchBoardWorkflows(projectId),
    });
  }, [addToast, confirm, confirmWithSelect, onDuplicateTask, projectId, task.id, t]);

  const handleTaskActionMerge = useCallback(async () => {
    if (!onMergeTask) return;
    const shouldMerge = await confirm({
      title: t("taskDetail.merge.title", "Merge Task"),
      message: t("taskDetail.merge.message", "Merge {{id}} into the current branch?", { id: task.id }),
    });
    if (!shouldMerge) return;
    addToast(t("taskDetail.merge.merging", "Merging {{id}}…", { id: task.id }), "info");
    void onMergeTask(task.id)
      .then((result) => {
        const message = result.merged
          ? t("taskDetail.merge.merged", "Merged {{id}} (branch: {{branch}})", { id: task.id, branch: result.branch })
          : t("taskDetail.merge.closed", "Closed {{id}} ({{reason}})", { id: task.id, reason: result.error || t("taskDetail.merge.noBranchToMerge", "no branch to merge") });
        addToast(message, "success");
      })
      .catch((err) => addToast(getErrorMessage(err), "error"));
  }, [addToast, confirm, onMergeTask, task.id, t]);

  const handleTaskActionPlan = useCallback(() => {
    const seed = (task.description ?? "").trim() || task.title || task.id;
    const taskWorkflowId = (task as Task & { workflowId?: string | null }).workflowId;
    onPlanningMode?.(seed, taskWorkflowId ?? planningWorkflowId ?? null);
  }, [onPlanningMode, planningWorkflowId, task, task.description, task.id, task.title]);

  const handleTaskActionCheckPrStatus = useCallback(async () => {
    try {
      await refreshPrStatus(task.id, projectId);
      addToast(t("taskDetail.pr.statusRefreshed", "PR status refreshed"), "success");
    } catch (err) {
      addToast(getErrorMessage(err), "error");
    }
  }, [addToast, projectId, task.id, t]);

  /*
  FNXC:BoardCardActions 2026-06-29-00:00:
  Board cards expose the same lifecycle actions as Task Detail from right-click, keyboard context menu, and touch long-press so operators can act without opening detail. Dock/plugin TaskCard users stay unchanged because the menu only mounts when Board/List owners pass action handlers.

  FNXC:BoardCardActions 2026-06-30-00:30:
  Context-menu moves reuse the Task Detail preserve/reset progress confirmation path before moving back to Todo or Triage, because those transitions can reset completed steps. Refine opens the existing Task Detail feedback modal from card right-click/long-press when the board host supplies that route, while manual PR entries open the existing PR flows instead of silently dropping unavailable actions.

  FNXC:BoardCardActions 2026-06-30-00:42:
  Board context menus must receive the project merge strategy, not infer pull-request mode from existing PR data, so manual PR projects show Start PR Review before the PR entity is created.

  FNXC:BoardCardActions 2026-06-30-12:42:
  Workflow-column card menus must use the task's workflow column flags and ordered column list instead of legacy column literals. Custom complete lanes are terminal for Reset/Pause, while custom active lanes still expose neighbor move targets.

  FNXC:BoardCardActions 2026-06-30-13:02:
  Manual pull-request projects need a distinct Start PR Review callback from direct Merge & Close so context menus open PrCreateModal instead of calling the merge endpoint.

  FNXC:GitHubTracking 2026-07-01-00:00:
  Board card context menus may enable GitHub tracking only when the board host supplies onUpdateTask, because that callback owns the existing PATCH flow plus optimistic/local task refresh. This keeps right-click, keyboard context menu, and touch long-press actions from becoming dead menu items in dock/plugin card embeddings.
  */
  const handleTaskActionEnableGithubTracking = useCallback(async () => {
    if (!onUpdateTask) return;
    try {
      await onUpdateTask(task.id, { githubTracking: { enabled: true } });
      addToast(t("taskDetail.githubTracking.issueCreationRequested", "Requested GitHub tracking issue creation"), "info");
    } catch (err) {
      addToast(t("taskDetail.updateFailed", "Failed to update {{id}}: {{error}}", { id: task.id, error: getErrorMessage(err) }), "error");
    }
  }, [addToast, onUpdateTask, task.id, t]);
  const taskColumnLabel = useCallback((column: ColumnId) => (
    taskMoveColumns?.find((candidate) => candidate.id === column)?.label ?? columnLabel(column)
  ), [columnLabel, taskMoveColumns]);

  const taskActionMenuModel = useMemo(() => buildTaskActionMenuModel({
    task,
    t,
    currentColumnFlags: taskColumnFlags,
    hasDuplicateHandler: Boolean(onDuplicateTask),
    hasRetryHandler: Boolean(onRetryTask),
    hasResetHandler: Boolean(onResetTask),
    hasAssignedAgent: Boolean(task.assignedAgentId),
    autoMergeEnabled: effectiveAutoMerge,
    mergeStrategy,
    prAutomationLabel: getTaskPrAutomationLabel(t, task.status),
    onDelete: onDeleteTask ? handleTaskActionDelete : undefined,
    onDuplicate: onDuplicateTask ? handleTaskActionDuplicate : undefined,
    onPlan: onPlanningMode ? handleTaskActionPlan : undefined,
    onOpenRefine: onOpenRefine ? () => onOpenRefine(task) : undefined,
    onRetry: onRetryTask ? handleTaskActionRetry : undefined,
    onReset: onResetTask ? handleTaskActionReset : undefined,
    onTogglePause: (isPaused ? onUnpauseTask : onPauseTask) ? handleTaskActionTogglePause : undefined,
    onMerge: onMergeTask ? handleTaskActionMerge : undefined,
    onStartPrReview: () => setIsPrCreateOpen(true),
    onCheckPrStatus: task.prInfo ? handleTaskActionCheckPrStatus : undefined,
    onEnableGithubTracking: onUpdateTask ? handleTaskActionEnableGithubTracking : undefined,
  }), [
    task,
    t,
    taskColumnFlags,
    onDuplicateTask,
    onRetryTask,
    onResetTask,
    effectiveAutoMerge,
    mergeStrategy,
    handleTaskActionCheckPrStatus,
    handleTaskActionDelete,
    handleTaskActionEnableGithubTracking,
    handleTaskActionDuplicate,
    handleTaskActionMerge,
    handleTaskActionPlan,
    handleTaskActionReset,
    handleTaskActionRetry,
    handleTaskActionTogglePause,
    isPaused,
    onDeleteTask,
    onMergeTask,
    onUpdateTask,
    onOpenDetail,
    onPlanningMode,
    onOpenRefine,
    onPauseTask,
    onUnpauseTask,
    task,
    task.assignedAgentId,
    task.column,
    task.prInfo,
  ]);
  const contextMenuActions = useMemo<TaskMenuItemDescriptor[]>(() => {
    if (!onDeleteTask && !onRevertTask && !onDuplicateTask && !onRetryTask && !onResetTask && !onPauseTask && !onUnpauseTask && !onMergeTask && !onPlanningMode && !onOpenRefine && !onUpdateTask) {
      return [];
    }
    const actions: TaskMenuItemDescriptor[] = [...taskActionMenuModel.actions];
    /*
    FNXC:TaskRevert 2026-07-05-00:00 (FN-7525):
    Context-menu Revert entry for completed work. Disabled (rather than omitted) when the task lacks a landed
    commit to revert, so the menu communicates WHY the affordance is inert
    instead of silently hiding it.
    */
    if (isCompleteColumn && onRevertTask) {
      actions.push({
        id: "revert",
        label: t("tasks.revert", "Revert"),
        disabled: !isRevertable,
        onSelect: isRevertable ? handleTaskActionRevert : undefined,
      });
    }
    if (taskActionMenuModel.reviewAction) {
      actions.push({ id: taskActionMenuModel.reviewAction.id, label: taskActionMenuModel.reviewAction.label, disabled: taskActionMenuModel.reviewAction.disabled, onSelect: taskActionMenuModel.reviewAction.onSelect });
    }
    return actions.filter((action) => "items" in action || action.tone === "note" || action.disabled === true || Boolean(action.onSelect));
  }, [handleTaskActionRevert, isCompleteColumn, isRevertable, onDeleteTask, onDuplicateTask, onMergeTask, onPlanningMode, onOpenRefine, onPauseTask, onResetTask, onRetryTask, onRevertTask, onUnpauseTask, onUpdateTask, taskActionMenuModel.actions, taskActionMenuModel.reviewAction]);
  const hasContextMenuActions = contextMenuActions.length > 0;

  const closeContextMenu = useCallback(() => {
    setContextMenuPosition(null);
  }, []);

  useEffect(() => {
    closeContextMenu();
  }, [closeContextMenu, task.column, task.githubTracking?.enabled, task.id]);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressStartRef.current = null;
  }, []);

  const openContextMenuAt = useCallback((clientX: number, clientY: number) => {
    if (!hasContextMenuActions || isEditing) return;
    setContextMenuPosition({
      x: Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(clientX, window.innerWidth - CONTEXT_MENU_VIEWPORT_MARGIN)),
      y: Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(clientY, window.innerHeight - CONTEXT_MENU_VIEWPORT_MARGIN)),
    });
  }, [hasContextMenuActions, isEditing]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!hasContextMenuActions || isInteractiveTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    suppressNextCardClickRef.current = true;
    openContextMenuAt(e.clientX, e.clientY);
  }, [hasContextMenuActions, isInteractiveTarget, openContextMenuAt]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!hasContextMenuActions) return;
    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
    if (isInteractiveTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    suppressNextCardClickRef.current = true;
    openContextMenuAt(
      rect.left + Math.min(rect.width - CONTEXT_MENU_VIEWPORT_MARGIN, KEYBOARD_CONTEXT_MENU_OFFSET),
      rect.top + Math.min(rect.height - CONTEXT_MENU_VIEWPORT_MARGIN, KEYBOARD_CONTEXT_MENU_OFFSET),
    );
  }, [hasContextMenuActions, isInteractiveTarget, openContextMenuAt]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!hasContextMenuActions || e.pointerType === "mouse" || isInteractiveTarget(e.target)) return;
    /*
    FNXC:TaskCardMobileSelection 2026-07-01-00:00:
    Touch/pen long-press is reserved for the Board task context menu. Prevent the native selection/copy callout before the timer starts while leaving mouse right-click, keyboard menu access, and editable descendants on their normal paths.
    */
    e.preventDefault();
    clearLongPressTimer();
    longPressStartRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      suppressNextCardClickRef.current = true;
      touchOpenHandledRef.current = true;
      openContextMenuAt(e.clientX, e.clientY);
    }, TOUCH_CONTEXT_MENU_DELAY_MS);
  }, [clearLongPressTimer, hasContextMenuActions, isInteractiveTarget, openContextMenuAt]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = longPressStartRef.current;
    if (!start || start.pointerId !== e.pointerId) return;
    if (Math.abs(e.clientX - start.x) > TOUCH_MOVE_THRESHOLD || Math.abs(e.clientY - start.y) > TOUCH_MOVE_THRESHOLD) {
      clearLongPressTimer();
    }
  }, [clearLongPressTimer]);

  const handlePointerUpOrCancel = useCallback(() => {
    clearLongPressTimer();
  }, [clearLongPressTimer]);

  /*
  FNXC:TaskCardMenu 2026-07-10-12:00:
  First-run review: the card's Edit/Delete/Review/New chat/Interventions actions were ONLY reachable
  via right-click (or touch long-press), which the user never discovered. Add a visible ⋯ button that
  opens the SAME portaled TaskContextMenu (same `contextMenuActions` model — no duplicated item
  logic), anchored under the button. Toggles closed when the menu is already open. Rendered only when
  `hasContextMenuActions` so no empty button shell appears on handler-less surfaces (e.g. read-only
  docks). Hover-revealed on desktop, always visible on mobile/touch (see TaskCard.css).
  */
  const handleMenuButtonClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (contextMenuPosition) {
      closeContextMenu();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    suppressNextCardClickRef.current = true;
    openContextMenuAt(rect.left, rect.bottom + MENU_BUTTON_MENU_GAP);
  }, [closeContextMenu, contextMenuPosition, openContextMenuAt]);

  /*
  FNXC:TaskContextMenu 2026-07-01-00:00:
  Board columns intentionally clip and scroll their bodies, so card context menus must be portaled to document.body and positioned in viewport coordinates. Clamp after render using the measured menu size so right-click, keyboard, and long-press menus escape column borders without weakening board overflow containment.
  */
  useLayoutEffect(() => {
    if (!contextMenuPosition) return;
    const menu = contextMenuRef.current;
    if (!menu) return;
    const menuRect = menu.getBoundingClientRect();
    const nextPosition = {
      x: Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(contextMenuPosition.x, window.innerWidth - menuRect.width - CONTEXT_MENU_VIEWPORT_MARGIN)),
      y: Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(contextMenuPosition.y, window.innerHeight - menuRect.height - CONTEXT_MENU_VIEWPORT_MARGIN)),
    };
    if (nextPosition.x !== contextMenuPosition.x || nextPosition.y !== contextMenuPosition.y) {
      setContextMenuPosition(nextPosition);
    }
  }, [contextMenuPosition]);

  useEffect(() => {
    if (!contextMenuPosition) return;
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      // FNXC:TaskCardMenu 2026-07-10-12:00: let the ⋯ button's own click handler toggle the menu closed
      // instead of racing it shut on pointerdown (see menuButtonRef comment above).
      if (menuButtonRef.current?.contains(event.target as Node)) return;
      closeContextMenu();
    };
    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContextMenu();
    };
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    window.addEventListener("scroll", closeContextMenu, true);
    return () => {
      document.removeEventListener("pointerdown", handleDocumentPointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
      window.removeEventListener("scroll", closeContextMenu, true);
    };
  }, [closeContextMenu, contextMenuPosition]);

  useEffect(() => {
    const cancelLongPress = () => clearLongPressTimer();
    window.addEventListener("scroll", cancelLongPress, true);
    return () => {
      window.removeEventListener("scroll", cancelLongPress, true);
      clearLongPressTimer();
    };
  }, [clearLongPressTimer]);

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

  const handleStartClick = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!onMoveTask || isStarting || startPendingColumn !== null) return;
    setIsStarting(true);
    setStartPendingColumn(task.column);
    try {
      await onMoveTask(task.id, startTargetColumn, { expectedColumn: task.column });
      /*
      FNXC:CodingIdeasWorkflow 2026-07-25-12:05:
      Honest copy: Start performs a column move, not a plan dispatch. "Started planning" claimed an
      outcome this handler cannot observe — the engine still has to admit the card, and a busy
      concurrency pool (maxConcurrent / globalMaxConcurrent) can defer that indefinitely, which
      made a throttled card look broken. The card's "Queued to plan" badge carries the live state.
      */
      addToast(t("tasks.queuedForPlanning", "Queued {{taskId}} for planning", { taskId: task.id }), "success");
    } catch (err) {
      setStartPendingColumn(null);
      addToast(getErrorMessage(err), "error");
    } finally {
      setIsStarting(false);
    }
  }, [addToast, isStarting, onMoveTask, startPendingColumn, startTargetColumn, t, task.column, task.id]);

  const handleAddressPrFeedbackClick = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (isAddressingPrFeedback) return;

    setIsAddressingPrFeedback(true);
    try {
      await addressPrFeedback(task.id, projectId);
      addToast(t("tasks.addressPrFeedbackStarted", "Addressing PR feedback — AI session started"), "success");
    } catch (err) {
      addToast(t("tasks.addressPrFeedbackFailed", "Failed to start PR feedback session: {{error}}", { error: getErrorMessage(err) }), "error");
    } finally {
      setIsAddressingPrFeedback(false);
    }
  }, [addToast, isAddressingPrFeedback, projectId, t, task.id]);

  const handleRetryTask = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    // FNXC:TaskRecoveryVocabulary 2026-08-28-01:11: The error-banner Retry discards
    // the same stage artifacts as the context-menu action, so it must share that confirmation
    // boundary instead of calling the route directly.
    void handleTaskActionRetry();
  }, [handleTaskActionRetry]);

  const cardClass = `card${queued ? " queued" : ""}${isAgentActive ? " agent-active" : ""}${isFailed ? " failed" : ""}${isPaused ? " paused" : ""}${isExternalBlocked ? " external-blocked" : ""}${isAwaitingApproval ? " awaiting-approval plan-approval-hold" : ""}${isAwaitingInput ? " awaiting-input" : ""}${fileDragOver ? " file-drop-target" : ""}${isEditing ? " card-editing" : ""}${isSaving ? " card-saving" : ""}`;

  const filesChangedButton = (() => {
    if (isWipColumn) {
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

    if (isReviewColumn) {
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

    if (isCompleteColumn) {
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

  const chipFarRight = showsTimeIndicator
    && filesChangedButton == null
    && showTrackingIndicator
    && Boolean(githubTrackedIssue);
  const footerHasLeadingContent = Boolean(filesChangedButton)
    || (isGitHubImportedTask && !showLinkedIssueChipForImport);
  const costBadgeChip = cardCostLabel ? (
    <span
      className="card-cost-indicator"
      title={t("tasks.costBadgeTitle", "Estimated cost {{amount}}", { amount: cardCostLabel })}
      aria-label={t("tasks.costBadgeAriaLabel", "Estimated cost {{amount}}", { amount: cardCostLabel })}
    >
      {/*
      FNXC:TaskCardCostBadge 2026-07-12-00:00:
      The cost chip must show only the formatted amount because formatCost already includes the currency symbol; do not render a leading dollar-sign icon that duplicates the label.
      */}
      <span>{cardCostLabel}</span>
    </span>
  ) : null;
  const footerRightHasContent = Boolean(cardCostLabel
    || timeIndicator
    || showNearDuplicateChip
    || showUndoOfChip
    || showRefinesChip
    || showRevertedChip
    || ((showTrackingIndicator || showLinkedIssueChipForImport) && githubTrackedIssue)
    || (task.retrySummary?.total ?? 0) > 0);
  /*
   * FNXC:TaskCardCostBadge 2026-07-12-00:00:
   * The footer-right badge cluster (cost, timing, retry, duplicate, and tracking chips) should render inline at the bottom-right of `.card-meta` when the footer has no leading content. Cards with files-changed or GitHub source-provenance leading content keep the existing `.card-footer-row` layout so in-progress and tracked-card footer behavior remains stable.
   */
  const placeFooterRightInMeta = footerRightHasContent
    && !footerHasLeadingContent
    && !chipFarRight
    && metaRowVisible;
  const footerRightCluster = footerRightHasContent ? (
    <div className="card-footer-row-right">
      {showUndoOfChip && (
        <span
          className="card-undo-chip"
          title={t("tasks.undoOfTitle", "Created to undo {{id}}", { id: String(revertOfId) })}
          aria-label={t("tasks.undoOfTitle", "Created to undo {{id}}", { id: String(revertOfId) })}
        >
          <span>{t("tasks.undoOf", "Undo of {{id}}", { id: String(revertOfId) })}</span>
        </span>
      )}
      {showRefinesChip && (
        <span
          className="card-refine-chip"
          title={t("tasks.refinesOfTitle", "Refinement of {{id}}", { id: String(refinesParentId) })}
          aria-label={t("tasks.refinesOfTitle", "Refinement of {{id}}", { id: String(refinesParentId) })}
        >
          {/* Decorative: the accessible name is already on the chip via aria-label. */}
          <Sparkles size={11} aria-hidden="true" />
          <span>{t("tasks.refinesOf", "Refines {{id}}", { id: String(refinesParentId) })}</span>
        </span>
      )}
      {showRevertedChip && (
        <span
          className="card-reverted-chip"
          title={t("tasks.revertedBadgeTitle", "This task's changes were reverted")}
          aria-label={t("tasks.revertedBadgeTitle", "This task's changes were reverted")}
        >
          <span>{t("tasks.revertedBadge", "Reverted")}</span>
        </span>
      )}
      {showRevertedChip && (
        <span className="card-reverted-actions" aria-label={t("tasks.revertedResolutionActions", "Reverted task resolution actions")}>
          {onDeleteTask && <button type="button" className="btn" onClick={(event) => { event.stopPropagation(); void handleTaskActionDelete(); }}>{t("tasks.delete", "Delete")}</button>}
          {onReviseTask && <button type="button" className="btn" onClick={(event) => { event.stopPropagation(); onReviseTask(task); }}>{t("tasks.revise", "Revise")}</button>}
        </span>
      )}
      {showNearDuplicateChip && (
        /*
        FNXC:NearDuplicateDetection 2026-08-23-04:10:
        FN-173 removed the undiscoverable Keep decision button. The tag is an acknowledgeable notification;
        clearing it deliberately uses dismissNearDuplicate so triage-marker holds release instead of stranding paused cards.
        */
        <span className="card-duplicate-chip-group">
          <span
            className="card-duplicate-chip"
            title={isTriageDuplicateDecision
              ? t("tasks.nearDuplicateHeldTitle", "Flagged as a duplicate of {{id}}. This task stays paused until you clear this flag or delete it.", { id: String(task.sourceMetadata?.nearDuplicateOf) })
              : t("tasks.nearDuplicateTitle", "Flagged as a possible duplicate of {{id}}. This task continues normally; clear the flag once you have read it.", { id: String(task.sourceMetadata?.nearDuplicateOf) })}
            aria-label={isTriageDuplicateDecision
              ? t("tasks.nearDuplicateHeldTitle", "Flagged as a duplicate of {{id}}. This task stays paused until you clear this flag or delete it.", { id: String(task.sourceMetadata?.nearDuplicateOf) })
              : t("tasks.nearDuplicateTitle", "Flagged as a possible duplicate of {{id}}. This task continues normally; clear the flag once you have read it.", { id: String(task.sourceMetadata?.nearDuplicateOf) })}
          >
            <span>{t("tasks.duplicateOf", "Duplicate of {{id}}", { id: String(task.sourceMetadata?.nearDuplicateOf) })}</span>
          </span>
          {onUpdateTask && (
            <button
              type="button"
              className="card-duplicate-dismiss"
              onClick={(e) => void handleDismissNearDuplicate(e)}
              title={t("tasks.dismissDuplicateFlag", "Mark the duplicate flag for {{id}} as read", { id: String(task.sourceMetadata?.nearDuplicateOf) })}
              aria-label={t("tasks.dismissDuplicateFlag", "Mark the duplicate flag for {{id}} as read", { id: String(task.sourceMetadata?.nearDuplicateOf) })}
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </span>
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
      {costBadgeChip}
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
  ) : null;
  const hasWorkflowBadge = typeof workflowBadge?.workflowId === "string"
    && workflowBadge.workflowId.trim().length > 0
    && typeof workflowBadge.workflowName === "string"
    && workflowBadge.workflowName.trim().length > 0;
  /*
   * FNXC:PlannerOversight 2026-07-04-HH:MM:
   * FN-7542 removed the active-overseer-state ("Executor") chip from this
   * guard — operators found it fired as noise on nearly every in-progress
   * card. The oversight-level badge (`showOversightBadge`) is untouched.
   */
  /*
  FNXC:TaskStatusBadge 2026-07-28-12:00:
  FN-8300 keeps Planning cards visually consistent with their fresh planner-log timeline: a transient client signal renders the existing pulsing Planning badge even while the authoritative status is null. ListView uses the same condition on both render paths.
  */
  const isTransientPlannerActive = isIntakeColumn
    && !visualStatus
    && Boolean(task.recentAgentActivityAt)
    && isAgentActive;
  const isLivePlanning = isTaskPlanningActive(task, { globalPaused });
  /*
  FNXC:TaskCardBadgePrecedence 2026-08-06-14:53:
  A visible non-planning gate is the lifecycle authority while it runs, so suppress only the
  contradictory Planning status shell. Plan Review is intentionally excluded by the shared helper:
  Planning + Plan Review expresses nested planning, while Planning + Code Review is stale state.
  Paused, approval, merge, and other operator states retain their existing precedence.
  */
  const suppressPlanningStatusBadge = showOptionalGateBadge && isNonPlanningOptionalGateBadge(optionalGateBadge);
  const isPlanningStatusBadge = !isPlanReviewReplanCapApproval
    && !isAwaitingApproval
    && !isAwaitingInput
    && (isLivePlanning || isTransientPlannerActive || visualStatus === "planning");
  /*
  FNXC:TaskStatusBadge 2026-08-01-07:20 (operator: queued belongs with Planning and Ready):
  Queued used to render as a clock-and-text footer tag, separating the waiting state from the
  Planning and Ready badges operators compare it with. Treat every non-WIP queued card as a normal
  header status badge instead. The shared badge geometry and column color carry desktop/mobile
  behavior; no standalone queued visual remains at the bottom of the card.
  */
  const showQueuedBadge = !isPaused
    && !isWipColumn
    && (queued || visualStatus === "queued");
  const wipLifecycleBadgeLabel = !isPaused
    && !isPlanReviewReplanCapApproval
    && !isAwaitingApproval
    && !showOptionalGateBadge
    && !showReadyBadge
    && !showQueuedToPlanBadge
    ? getTaskWipLifecycleBadgeLabel(visualStatus, t, {
      isWipColumn,
      lifecycleLabel: taskColumnLabel(task.column),
    })
    : null;
  const showStatusBadge = !isPaused
    && (hasTaskStatusBadge(visualStatus) || isTransientPlannerActive || Boolean(wipLifecycleBadgeLabel))
    && visualStatus !== "queued"
    && !(suppressPlanningStatusBadge && isPlanningStatusBadge);
  /*
  FNXC:TaskStatusBadge 2026-07-26-14:05:
  The status badge's resolved copy, hoisted out of the JSX. U12 lets this badge borrow the running
  workflow step's IR name ("Plan Review"), but the optional-gate badge now uses that same name
  instead of the generic "Reviewing" — applying both printed "Plan Review" twice on one card. The
  gate badge owns the gate's identity, so the override is dropped while it renders and this badge
  states the card's own status ("Planning"). The two badges stay orthogonal: what the card IS, and
  which gate is RUNNING.
  */
  const statusBadgeLabel = isPlanReviewReplanCapApproval
      ? t("tasks.reviewBudgetExhausted", "Review budget exhausted")
      : isAwaitingApproval
        ? t("tasks.awaitingApproval", "Awaiting Approval")
        : isAwaitingInput
          ? t("tasks.needsInput", "Needs input")
          : isLivePlanning || isTransientPlannerActive
            ? t("tasks.statusPlanning", "Planning")
            /*
            FNXC:TaskStatusBadge 2026-08-01-03:20 (operator: ONE queued badge family, no dupes):
            Queued-to-plan renders through THIS badge now — same span, same family as Planning —
            instead of the standalone `queued-to-plan` pill it used to be (removed below). One card,
            one badge; the muted modifier class and testid survive on this span.
            */
            : showQueuedToPlanBadge
              ? t("tasks.queuedToPlan", "Queued to plan")
              : showQueuedBadge
                ? t("tasks.statusQueued", "Queued")
                : wipLifecycleBadgeLabel
                  ?? getTaskStatusLabel(visualStatus ?? "", t, showOptionalGateBadge ? undefined : getRunningWorkflowStepLabel(task), { idle: !isAgentActive, overlapBlockedBy: task.overlapBlockedBy ?? null, sessionContentionWaitReason: task.sessionContentionWaitReason ?? null });
  const hasCardMetaBadges = showPriorityBadge
    || task.executionMode === "fast"
    // FNXC:PlannerOversight 2026-07-04-00:00: the oversight badge is opt-in
    // metadata (absent for the common "off" default) — include it in the wrapper
    // guard so `.card-meta-badges` only renders when it has a real child.
    || showOversightBadge;
  const hasHeaderBadges = Boolean(isPaused)
    || showStatusBadge
    || showOptionalGateBadge
    || showReadyBadge
    || showQueuedBadge
    // FNXC:CodingIdeasWorkflow 2026-07-25-12:05: the header wrapper only renders when it has a
    // real child, so a new badge must be declared here or it never mounts (Queued to plan is the
    // only badge on an unplanned idle Todo card — without this the whole cluster stays absent).
    || showQueuedToPlanBadge
    || Boolean(hasInReviewStall && stallCopy)
    || cliWaitingOnInput
    || cliNeedsAttention
    || Boolean(hasStalePausedReview && stalePausedReviewCopy)
    || Boolean(hasTaskAgeStaleness && taskAgeStalenessCopy)
    || Boolean(Array.isArray((task as TaskWithBranchProgress).branchProgress) && (task as TaskWithBranchProgress).branchProgress!.length > 0)
    || showPlannerOverseerStateBadge
    || Boolean(showStalledReview && stalledReview)
    || Boolean(livePrInfo || liveIssueInfo)
    || Boolean(task.gitlabTracking?.item)
    || Boolean(prNode)
    || hasCardMetaBadges
    || task.noCommitsExpected === true
    || Boolean(task.missionId);
  const hasHeaderActions = Boolean(isAwaitingInput && onOpenDetailWithTab)
    || Boolean(canEdit)
    || Boolean(isIntakeColumn && onDeleteTask)
    || Boolean(isCompleteColumn && onRevertTask && isRevertable)
    || Boolean(task.size)
    || hasContextMenuActions;

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

  /*
  FNXC:TaskCardMenu 2026-08-01-16:06:
  React portal events bubble through the TaskCard owner tree even though this menu lives under document.body.
  Stop every touch, pointer, compatibility-click, and keyboard path at the portal wrapper so selecting any menu action cannot invoke card detail opening while TaskContextMenu keeps its own dispatch and navigation behavior.
  */
  return (
    <div
      ref={cardRef}
      className={cardClass}
      data-id={task.id}
      data-column={task.column}
      onDragOver={handleFileDragOver}
      onDragLeave={handleFileDragLeave}
      onDrop={handleFileDrop}
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUpOrCancel}
      onPointerCancel={handlePointerUpOrCancel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handlePointerUpOrCancel}
      onDoubleClick={handleDoubleClick}
      tabIndex={hasContextMenuActions ? 0 : undefined}
      aria-haspopup={hasContextMenuActions ? "menu" : undefined}
    >
      {contextMenuPosition && hasContextMenuActions && createPortal(
        <div
          ref={contextMenuRef}
          className="task-card-context-menu-popover"
          style={{ left: contextMenuPosition.x, top: contextMenuPosition.y } as CSSProperties}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onPointerCancel={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
          onTouchEnd={(event) => event.stopPropagation()}
          onTouchCancel={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <TaskContextMenu
            actions={contextMenuActions}
            onActionSelect={closeContextMenu}
          />
        </div>,
        document.body,
      )}
      {isExternalBlocked && (
        <ExternalBlockNotice
          task={task}
          variant="card"
          onOpenChatWithPrefill={onOpenChatWithPrefill}
          onRetryTask={onRetryTask}
          addToast={addToast}
        />
      )}
      {!isExternalBlocked && isAwaitingApproval && (
        <PlanApprovalNotice
          task={task}
          variant="card"
          projectId={projectId}
          addToast={addToast}
          isPlanningLane={isPlanningLane}
        />
      )}
      <div className="card-header">
        <span className="card-id">{task.id}</span>
        {/*
        FNXC:TaskCardLayout 2026-07-17-13:05 (FN-8234):
        The size chip reads immediately after the task id and before the wrapping middle badge group, superseding FN-7846's former last-item placement in the right actions cluster. Preserve FN-7837's non-wrapping outer header: extra status and priority badges wrap only in the middle group.
        */}
        {task.size && (
          <span className={`card-size-badge size-${task.size.toLowerCase()}`}>
            {task.size}
          </span>
        )}
        {hasHeaderBadges && (
          /*
          FNXC:TaskCardLayout 2026-07-11-00:00:
          FN-7837 keeps the task id, size chip, and right-aligned actions cluster in the same non-wrapping header row. Extra header badges (fast-mode, priority, oversight, decision-only, PR/GitHub, and status chips) wrap inside this middle group instead of pushing header metadata onto a misaligned second row on desktop or mobile.
          */
          <div className="card-header-badges" data-testid="card-header-badges">
        {isPaused && (
          <span
            className={`card-status-badge paused${isTriageDuplicateDecision ? " needs-user-feedback" : ""}`}
            title={isTriageDuplicateDecision
              ? t("tasks.duplicateDecisionRequiredTitle", "This task is a duplicate candidate and needs your decision.")
              : undefined}
            data-testid={isTriageDuplicateDecision ? `card-needs-user-feedback-${task.id}` : undefined}
          >
            {isTriageDuplicateDecision
              ? t("tasks.needsUserFeedback", "Needs your decision")
              : pausedByAgent ? t("tasks.pausedByAgent", "paused by agent") : t("tasks.paused", "paused")}
          </span>
        )}
        {(showStatusBadge || showQueuedToPlanBadge || showQueuedBadge) && (
          <span
            className={`card-status-badge card-status-badge--${task.column}${showQueuedToPlanBadge ? " queued-to-plan" : ""}${showQueuedBadge && (task.overlapBlockedBy || task.blockedBy) ? " card-status-badge--queued-with-reason" : ""}${isAwaitingApproval ? " awaiting-approval" : ""}${isPlanReviewReplanCapApproval ? " awaiting-approval--plan-review-replan-cap" : ""}${isAwaitingInput ? " awaiting-input" : ""}${isAgentActive ? " pulsing" : ""}${isFailed ? " failed" : ""}`}
            title={
              isPlanReviewReplanCapApproval
                ? t(
                    "tasks.awaitingApprovalPlanReviewReplanCapTitle",
                    "Plan Review requested revisions repeatedly without converging. Approve the current plan to proceed, or reject to regenerate it.",
                  )
                : isAwaitingApproval
                  ? t(
                      "tasks.awaitingApprovalTitle",
                      "This plan needs your approval before implementation can start.",
                    )
                  /*
                  FNXC:TaskStatusBadge 2026-07-31-23:20:
                  `needs-replan` is a durable WAITING state (the graph's replan signal), not a live
                  session — the actual revise run surfaces as "planning" once triage re-admits it.
                  Operators read "Revising" as activity and counted it against the concurrency
                  panel ("five planning badges, four running agents"); mirror QUEUED TO PLAN's
                  disambiguation as a tooltip so the label (FN-8493 copy) stays untouched while an
                  idle Revising card explains itself. Gated on !isAgentActive so a genuinely
                  running revise cycle keeps no misleading "waiting" text.
                  */
                  : showQueuedToPlanBadge
                    ? queuedToPlanTitle
                  : showQueuedBadge && task.overlapBlockedBy
                    ? t("tasks.queuedFileOverlapTitle", "Queued due to file overlap with {{taskId}}", { taskId: task.overlapBlockedBy })
                  : showQueuedBadge && task.blockedBy
                    ? t("tasks.queuedDependencyTitle", "Queued on dependency {{taskId}}", { taskId: task.blockedBy })
                  : task.status === "needs-replan" && !isAgentActive
                    ? t(
                        "tasks.needsReplanQueuedTitle",
                        "Waiting to revise the plan — the revision starts when a planning slot frees up.",
                      )
                    : undefined
            }
            aria-label={isLivePlanning || isTransientPlannerActive ? t("tasks.statusPlanning", "Planning") : undefined}
            data-testid={isAwaitingApproval ? `card-awaiting-approval-${task.id}` : showQueuedToPlanBadge ? `card-queued-to-plan-${task.id}` : undefined}
            data-awaiting-approval-reason={isAwaitingApproval ? (task.awaitingApprovalReason ?? "manual") : undefined}
          >
            {statusBadgeLabel}
            {showQueuedBadge && task.overlapBlockedBy && (
              <Layers className="card-queued-reason-icon" size={7} aria-hidden="true" data-testid={`card-queued-overlap-icon-${task.id}`} />
            )}
            {showQueuedBadge && !task.overlapBlockedBy && task.blockedBy && (
              <Link className="card-queued-reason-icon" size={7} aria-hidden="true" data-testid={`card-queued-dependency-icon-${task.id}`} />
            )}
          </span>
        )}
        {showOptionalGateBadge && optionalGateBadge && (
          /*
          FNXC:TaskCardPlanReviewBadge 2026-07-11-12:06:
          The Reviewing badge is additive to the normal header status badge so operators can distinguish "planning" from active Plan Review without hiding paused/status affordances.

          FNXC:TaskCardOptionalGateBadge 2026-07-21-22:30:
          Same additive pattern for Code Review / Browser Verification in In-review. Label is the gate's own name. These gates stay out of the WIP bullet list.

          FNXC:TaskCardOptionalGateBadge 2026-07-26-14:05:
          Plan Review (and its replan loop) now badges as "Plan Review" instead of the ambiguous "Reviewing", and the gate itself runs in the planning column, so the badge is visible on the Planning card rather than being lane-suppressed while the card sat in In progress.
          */
          <span
            className="card-status-badge card-status-badge--reviewing pulsing"
            data-testid={`card-${optionalGateBadge.testId}-${task.id}`}
            data-optional-gate={optionalGateBadge.workflowStepId}
            title={
              optionalGateBadge.workflowStepId === "plan-review" || optionalGateBadge.workflowStepId === "plan-replan"
                ? t("tasks.planReviewingTitle", "Plan Review in progress")
                : t("tasks.optionalGateRunningTitle", "{{name}} in progress", { name: optionalGateBadge.name })
            }
          >
            {optionalGateBadge.workflowStepId === "plan-review" || optionalGateBadge.workflowStepId === "plan-replan"
              ? t("tasks.planReviewBadge", "Plan Review")
              : optionalGateBadge.label}
          </span>
        )}
        {/*
        FNXC:CodingIdeasWorkflow 2026-07-04-11:10:
        In the merged planner/capacity "todo" column (Coding (Ideas)), a planned task with no active status is ready and waiting for an in-progress slot. Show a "Ready" badge so operators can distinguish planned cards from freshly promoted unplanned ones. Tasks still being planned surface the "planning" status badge above instead.

        FNXC:CodingIdeasWorkflow 2026-07-21-22:18:
        Suppress Ready while Plan Review (or other agent-active work) is live — finalize often clears status before plan-review, which previously stacked Ready + Reviewing on the same Todo card.
        */}
        {showReadyBadge && (
          <span
            className="card-status-badge card-status-badge--todo ready"
            data-testid={`card-ready-${task.id}`}
            title={t(
              "tasks.readyTitle",
              "Planning is done — implementation starts as soon as an implementation slot frees up.",
            )}
          >
            {t("tasks.ready", "Ready")}
          </span>
        )}
        {/*
        FNXC:CodingIdeasWorkflow 2026-07-25-12:05:
        Started-but-not-yet-planned. Reuses the Ready badge's primitives with the queued modifier
        rather than forking a new badge variant.

        FNXC:CapacityModel 2026-07-30-18:10 (capacity simplification — user-visible residue):
        The title used to name "maxConcurrent / globalMaxConcurrent". The cross-project cap is DELETED
        (capacity is two numbers per project), so that tooltip told the operator their planning was
        waiting on a limiter that no longer exists — and pointed them at a setting they can no longer
        find. Names the surviving dimension only. Worktrees can also be the binding gate, but only when
        the operator has worktree limiting on, so it is not stated unconditionally here.
        */}
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
        {/*
          FNXC:PlannerOversight 2026-07-04-00:00:
          FN-7531 provides `task.plannerOverseerState` (transient, engine-populated on the
          board payload) plus a repaint-correct memo comparator; FN-7516 owns the styled
          badge/design and surface-by-surface rendering. This is a minimal, type-safe,
          guarded read only — nothing renders for an absent field or the "idle" state.

          FNXC:PlannerOversight 2026-07-05-00:00:
          FN-7592 replaces the uppercase text label with a small state-colored `Eye` icon so
          the badge reads as a compact glyph. The readable label and composed tooltip stay
          available for accessibility: `aria-label` carries the state name (screen readers)
          and `title` keeps the existing tooltip (hover). Per-state color comes from the
          `data-planner-overseer-state` attribute in TaskCard.css — do not fork the label
          logic here; `plannerOverseerStateLabel`/`plannerOverseerBadgeTooltip` remain the
          single source of truth.

          FNXC:PlannerOversight 2026-07-17-00:00:
          FN-8221 defensively hides a stale non-idle snapshot when its oversight level is off.
          The engine clears this runtime at the source, but a client payload must never leak
          the Eye badge for an oversight-off in-progress or in-review task.
        */}
        {showPlannerOverseerStateBadge && plannerOverseerState && (
          <span
            className="card-status-badge card-planner-overseer-state"
            title={plannerOverseerBadgeTooltip(plannerOverseerState, t)}
            aria-label={plannerOverseerStateLabel(plannerOverseerState.state, t)}
            data-testid="planner-overseer-state-badge"
            data-planner-overseer-state={plannerOverseerState.state}
          >
            <Eye aria-hidden="true" />
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
              <a className={`card-github-badge ${getPrBadgeModifierClass(livePrInfo)}`} title={t("tasks.prBadgeTitle", "PR #{{number}}: {{title}}", { number: livePrInfo.number, title: livePrInfo.title })} href={livePrInfo.url} target="_blank" rel="noopener noreferrer">
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
        {task.gitlabTracking?.item && (
          <GitLabBadge item={task.gitlabTracking.item} />
        )}
        <RuntimeFallbackBadge taskId={task.id} isInViewport={isInViewport} projectId={projectId} />
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
              <span
                className={`card-priority-badge card-priority-badge--${normalizedPriority}`}
                title={getPriorityLabel(normalizedPriority)}
                aria-label={getPriorityLabel(normalizedPriority)}
              >
                {/* FNXC:PriorityIconOnlyBadge 2026-07-12-00:00: FN-7867 makes task-card priority badges icon-only so priority text cannot widen .card-meta-badges and force wrapping; preserve the label through title, aria-label, and visually-hidden text while keeping the shared urgency color. */}
                <PriorityBadgeIcon size={10} aria-hidden="true" style={{ color: getPriorityColorVar(normalizedPriority) }} />
                <span className="visually-hidden">{getPriorityLabel(normalizedPriority)}</span>
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
            {showOversightBadge && (
              <span
                className={`card-oversight-badge card-oversight-badge--${OVERSIGHT_BADGE_MODIFIER[effectiveOversightLevel as Exclude<PlannerOversightLevel, "off">]}`}
                data-testid="card-oversight-badge"
                title={t("tasks.oversightBadgeTitle", "Oversight: {{level}}", { level: OVERSIGHT_BADGE_LABEL[effectiveOversightLevel as Exclude<PlannerOversightLevel, "off">] })}
                aria-label={t("tasks.oversightBadgeTitle", "Oversight: {{level}}", { level: OVERSIGHT_BADGE_LABEL[effectiveOversightLevel as Exclude<PlannerOversightLevel, "off">] })}
              >
                {abbreviateBadge(OVERSIGHT_BADGE_LABEL[effectiveOversightLevel as Exclude<PlannerOversightLevel, "off">], 14)}
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
          </div>
        )}
        {hasHeaderActions && (
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
          {isIntakeColumn && onDeleteTask && (
            <button
              className="card-delete-btn"
              onClick={handleDeleteClick}
              title={t("tasks.deleteTask", "Delete task")}
              aria-label={t("tasks.deleteTask", "Delete task")}
            >
              <Trash2 size={12} />
            </button>
          )}
          {/*
          FNXC:TaskCardMenu 2026-07-10-12:00:
          Visible entry point for the card's action menu (Edit/Delete/Review/New chat/Interventions…)
          — previously right-click/long-press only and therefore undiscoverable. Opens the same
          portaled TaskContextMenu anchored at this button. Only rendered when the menu has actions
          (no empty shell); applies on every surface that renders TaskCard (Board columns, worktree
          groups, dock task lists).
          */}
          {hasContextMenuActions && (
            <button
              ref={menuButtonRef}
              type="button"
              className="card-menu-btn"
              onClick={handleMenuButtonClick}
              title={t("tasks.taskActions", "Task actions")}
              aria-label={t("tasks.taskActions", "Task actions")}
              aria-haspopup="menu"
              aria-expanded={contextMenuPosition != null}
              data-testid={`card-menu-btn-${task.id}`}
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        </div>
        )}
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
      {(() => {
        const titleDisplay = getTaskTitleDisplay(task);
        const titleText = titleDisplay.source === "title"
          ? truncate(titleDisplay.text, MAX_TITLE_LENGTH)
          : titleDisplay.text;
        return (
          <div
            className={`card-title${titleDisplay.isBoundedDescription ? " card-title--bounded-description" : ""}`}
            title={titleDisplay.fullText}
          >
            {titleText}
          </div>
        );
      })()}
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
              {activeProgressCount > 0 && (
                <span className="card-progress-active">
                  {t("tasks.activeStepCount", "{{count}} active", { count: activeProgressCount })}
                </span>
              )}
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
                {unifiedProgress.items.map((step, index) => {
                  const beginsReviewGates = step.source === "workflow" && index > 0 && unifiedProgress.items[index - 1]?.source === "step";
                  /*
                  FNXC:WorkflowSteps 2026-06-25-00:00:
                  The dot color is keyed by the unified status, which now distinguishes the two
                  workflow-failure modes: `advisory_failure` (non-blocking REVISE → amber/warning) vs
                  `failed` (blocking gate failure → red/error). `running` shows the in-progress color.
                  No `card-step-dot--workflow-failed` override is needed — the status class carries the
                  distinction directly.

                  FNXC:WorkflowSteps 2026-06-30-12:00:
                  Workflow-sourced rows remain visible through their step names and status dots, but task cards intentionally omit the redundant `workflow` text badge so expanded step lists stay focused on progress.
                  */
                  return (
                    <div key={step.id}>
                      {beginsReviewGates && <div className="card-review-gates-separator" aria-hidden="true" />}
                    <div className="card-step-item">
                      <span
                        className={`card-step-dot card-step-dot--${step.status}`}
                        aria-hidden="true"
                      />
                      <span className={`card-step-name${step.status === "done" ? " completed" : ""}${step.status === "in-progress" || step.status === "running" ? " active" : ""}`}>
                        {step.name}
                      </span>
                      {(step.status === "in-progress" || step.status === "running") && (
                        <span className="card-step-active-badge">
                          {t("tasks.active", "active")}
                        </span>
                      )}
                    </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        );
      })()}
      {(lifecycleDates.created || lifecycleDates.completed) && (
        <div className="card-lifecycle-dates" data-testid="card-lifecycle-dates">
          {lifecycleDates.created && (
            <time dateTime={lifecycleDates.created.dateTime} title={t("tasks.createdAtTitle", "Created {{date}}", { date: lifecycleDates.created.full })}>
              {t("tasks.createdAt", "Created {{date}}", { date: lifecycleDates.created.compact })}
            </time>
          )}
          {lifecycleDates.completed && (
            <time dateTime={lifecycleDates.completed.dateTime} title={t("tasks.completedAtTitle", "Completed {{date}}", { date: lifecycleDates.completed.full })}>
              {t("tasks.completedAt", "Completed {{date}}", { date: lifecycleDates.completed.compact })}
            </time>
          )}
        </div>
      )}
      {(footerHasLeadingContent || (footerRightHasContent && !placeFooterRightInMeta)) && (
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
          {!placeFooterRightInMeta && footerRightCluster}
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
            <span className="card-scope-badge" data-tooltip={t("tasks.blockedByTooltip", "Waiting for {{taskId}} (file overlap)", { taskId: task.overlapBlockedBy || task.blockedBy })}>
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
          {placeFooterRightInMeta && footerRightCluster}
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
              aria-label={t("tasks.assignedTo", "Assigned to {{name}}", { name: assignedAgentBadgeLabel })}
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
        <>
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
          {showAddressPrFeedbackAction && (
            <button
              type="button"
              className="card-create-pr-action card-address-pr-feedback-action"
              data-testid={`card-address-pr-feedback-${task.id}`}
              title={t("tasks.addressPrFeedbackTitle", "Start an AI session to address PR feedback")}
              aria-label={t("tasks.addressPrFeedbackAriaLabel", "Address PR feedback")}
              disabled={isAddressingPrFeedback}
              onClick={handleAddressPrFeedbackClick}
            >
              {/*
              FNXC:TaskCardPrFeedback 2026-06-28-00:00:
              Operators need the task card affordance to appear only when the primary linked PR has actionable feedback. The click seeds the ce-resolve-pr-feedback steering prompt through the lifecycle route instead of reading untrusted PR comments as instructions.
              */}
              <Bot size={12} />
              {isAddressingPrFeedback ? t("tasks.addressingPrFeedback", "Addressing…") : t("tasks.addressPrFeedback", "Address PR feedback")}
            </button>
          )}
          {showStartAction && (
            <button
              type="button"
              className="card-promote-action card-send-back-btn"
              data-testid={`card-start-${task.id}`}
              title={t("tasks.startTask", "Start — plan this task")}
              aria-label={t("tasks.startTask", "Start — plan this task")}
              disabled={isStarting || startPendingColumn !== null}
              onClick={handleStartClick}
            >
              <Zap size={12} />
              {isStarting ? t("tasks.starting", "Starting…") : t("tasks.start", "Start")}
            </button>
          )}
        </div>
        </>
      )}
      {shouldShowCreatedAgentBadge && (
        <div className="card-agent-badge-row" data-testid="card-agent-badge-row">
          {/**
           * FNXC:TaskCardLayout 2026-07-10-00:00:
           * FN-7780 moves the created-by-agent chip below the task content and before the workflow identity row so the header keeps only ID/status/actions metadata and no longer wraps on narrow/mobile cards. The badge content, tooltip, and accessible name remain unchanged.
           *
           * FNXC:TaskCardAgentBadges 2026-08-10-03:41:
           * FN-8930 requires current ownership and created-by provenance to never read as two assigned agents. Bot plus the filled owner pill means the current owner; Sparkles plus the outlined "by …" pill means creation provenance.
           */}
          <span
            className="card-agent-created-badge card-agent-created-badge--provenance"
            title={agentCreatedTitle}
            aria-label={agentCreatedTitle}
          >
            <Sparkles size={11} aria-hidden="true" />
            <span className="visually-hidden">{agentCreatedTitle}</span>
            <span aria-hidden="true">{agentCreatedVisibleLabel}</span>
          </span>
        </div>
      )}
      {hasWorkflowBadge && (
        <div className="card-workflow-badge-row" data-testid="card-workflow-badge-row">
          {/*
          FNXC:WorkflowBoard 2026-06-30-00:00:
          All workflows Board cards need workflow identity anchored at the card's bottom-left, below footer chips, dependency/meta rows, provider icons, and action controls, while per-workflow cards keep omitting this opt-in metadata.
          */}
          <span
            className="card-workflow-badge"
            title={t("tasks.workflowBadgeTitle", "Workflow: {{name}}", { name: workflowBadge.workflowName })}
            aria-label={t("tasks.workflowBadgeAriaLabel", "Workflow {{name}}", { name: workflowBadge.workflowName })}
            data-testid="card-workflow-badge"
            data-workflow-id={workflowBadge.workflowId}
          >
            <WorkflowIcon workflowId={workflowBadge.workflowId} icon={workflowBadge.workflowIcon} decorative />
            <span>{workflowBadge.workflowName}</span>
          </span>
        </div>
      )}
      <PluginSlot slotId="task-card-badge" projectId={projectId} />
      {showResetDialog && onResetTask && (
        <TaskResetDialog
          taskId={task.id}
          initialDescription={task.description}
          onReset={onResetTask}
          addToast={addToast}
          onClose={() => setShowResetDialog(false)}
        />
      )}
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
const TOUCH_CONTEXT_MENU_DELAY_MS = 550; // milliseconds
const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
const KEYBOARD_CONTEXT_MENU_OFFSET = 32;
// FNXC:TaskCardMenu 2026-07-10-12:00: vertical gap between the ⋯ button and the menu it anchors.
const MENU_BUTTON_MENU_GAP = 4;
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
