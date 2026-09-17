import { memo, useMemo, useCallback, useRef } from "react";
import { UiButton, UiSurface } from "./ui";
import { useAutoPaginationSentinel } from "../hooks/useAutoPaginationSentinel";
import { useVirtualizedList } from "../hooks/useVirtualizedList";
import { useTranslation } from "react-i18next";
import { useFlashOnIncrease } from "../hooks/useFlashOnIncrease";
import { COLUMN_LABELS, COLUMN_DESCRIPTIONS, type Task, type TaskDetail, type Column as ColumnType, type ColumnId, type TaskCreateInput, type GithubIssueAction, type MergeResult } from "@fusion/core";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/duplicates/near-duplicate-canonical";
import { TaskCard } from "./TaskCard";
import { WorktreeGroup } from "./WorktreeGroup";
import { QuickEntryBox } from "./QuickEntryBox";
import { PluginSlot } from "./PluginSlot";
import { groupByWorktree } from "../utils/worktreeGrouping";
import {
  isWipColumnRole,
} from "../utils/columnRoles";
import type { ToastType } from "../hooks/useToast";
import type { TaskContextMenuColumnMetadata } from "./TaskContextMenu";
import { History } from "lucide-react";
import type { BoardWorkflowDefinition, ModelInfo, BoardWorkflowColumnFlags, RestoreTaskRevertOptions, RestoreTaskRevertResult, RevertTaskOptions, RevertTaskResult } from "../api";
import type { BlockerFanoutEntry } from "../hooks/useBlockerFanout";
import "./Column.css";

/** Shape of a structured transition rejection carried in a 409's `details`. */
interface TransitionRejectionDetail {
  code: string;
  messageKey: string;
  retryable: boolean;
}

/**
 * Pull a typed transition rejection out of an `ApiRequestError`'s `details`
 * (the structured 409 the move/promote endpoints emit under the workflowColumns
 * flag). Returns null for any other error shape (legacy errors are unchanged).
 */
export function extractTransitionRejection(err: unknown): TransitionRejectionDetail | null {
  const details = (err as { details?: Record<string, unknown> } | null)?.details;
  if (!details || typeof details !== "object") return null;
  const { code, messageKey, retryable } = details as Record<string, unknown>;
  if (typeof code === "string" && typeof messageKey === "string") {
    return { code, messageKey, retryable: retryable === true };
  }
  return null;
}

/**
 * Resolve a rejection (by stable code, falling back to its messageKey) to
 * user-facing copy. The static `t()` literals here are what the i18next
 * extractor sees, so the `board.rejection.*` keys persist in the catalog and
 * the surfaces show real copy rather than a raw key. The `messageKey` carried by
 * the rejection is still honored as the lookup so a server-chosen non-default
 * key resolves correctly.
 */
type TFn = (key: string, defaultValue: string) => string;
export function translateRejection(t: TFn, rejection: TransitionRejectionDetail): string {
  switch (rejection.code) {
    case "guard-rejected":
      return t("board.rejection.guardRejected", "This move is not allowed by the workflow.");
    case "capacity-exhausted":
      return t("board.rejection.capacityExhausted", "That column is at capacity. Try again when a slot frees up.");
    case "unknown-column":
      return t("board.rejection.unknownColumn", "That column doesn't exist in this task's workflow.");
    case "workflow-mismatch":
      return t("board.rejection.workflowMismatch", "Drag can't move a card between workflows. Use the workflow switcher instead.");
    case "merge-blocked":
      return t("board.rejection.mergeBlocked", "This task is blocked from completing until its merge step finishes.");
    /*
    FNXC:BoardRejections 2026-07-25-04:55:
    FN-8471 added this server-side code without a client case or catalog entry, so
    the default branch fell through to `t(messageKey, messageKey)` and the board
    printed the raw `board.rejection.unplannedForExecution` key at operators. The
    static literal here is also what the i18next extractor sees, so the key must
    be spelled out in the switch rather than resolved via the carried messageKey.
    */
    case "unplanned-for-execution":
      return t(
        "board.rejection.unplannedForExecution",
        "This task isn't ready for execution yet — planning or plan review is still outstanding.",
      );
    case "stale-move-precondition":
      return t(
        "board.rejection.staleMovePrecondition",
        "This card already moved on. Refresh to see where it is now.",
      );
    default:
      return t(rejection.messageKey, rejection.messageKey);
  }
}

/** Translate a bare drag pre-check messageKey (R17 no-move) to copy. The same
 *  static literals as {@link translateRejection} so the extractor keeps them. */
export function translateRejectionKey(t: TFn, messageKey: string): string {
  switch (messageKey) {
    case "board.rejection.guardRejected":
      return t("board.rejection.guardRejected", "This move is not allowed by the workflow.");
    case "board.rejection.capacityExhausted":
      return t("board.rejection.capacityExhausted", "That column is at capacity. Try again when a slot frees up.");
    case "board.rejection.unknownColumn":
      return t("board.rejection.unknownColumn", "That column doesn't exist in this task's workflow.");
    case "board.rejection.workflowMismatch":
      return t("board.rejection.workflowMismatch", "Drag can't move a card between workflows. Use the workflow switcher instead.");
    case "board.rejection.mergeBlocked":
      return t("board.rejection.mergeBlocked", "This task is blocked from completing until its merge step finishes.");
    case "board.rejection.unplannedForExecution":
      return t(
        "board.rejection.unplannedForExecution",
        "This task isn't ready for execution yet — planning or plan review is still outstanding.",
      );
    case "board.rejection.staleMovePrecondition":
      return t(
        "board.rejection.staleMovePrecondition",
        "This card already moved on. Refresh to see where it is now.",
      );
    default:
      return t(messageKey, messageKey);
  }
}

interface ColumnProps {
  column: ColumnType;
  tasks: Task[];
  projectId?: string;
  maxConcurrent: number;
  /** Execution-worktree ceiling used for the Up Next preview. */
  maxWorktrees: number;
  showWorktreeGrouping: boolean;
  onMoveTask: (id: string, column: ColumnId, optionsOrPosition?: { preserveProgress?: boolean; expectedColumn?: string } | number) => Promise<Task>;
  /* FNXC:TaskQueueOrder 2026-09-17-12:07: FN-509 — every host that renders a LIVE card forwards Boost,
     so the affordance is not tied to one surface. Omitting it withholds the button. */
  onBoostTask?: (id: string, scope: { expectedColumn: string; expectedColumnEntryAt: string }) => Promise<Task>;
  onPauseTask?: (id: string) => Promise<Task>;
  onUnpauseTask?: (id: string) => Promise<Task>;
  onResetTask?: (id: string, options?: { description?: string }) => Promise<Task>;
  onDuplicateTask?: (id: string, options?: { workflowId?: string }) => Promise<Task>;
  onMergeTask?: (id: string) => Promise<MergeResult>;
  onOpenDetail: (task: Task | TaskDetail) => void;
  /** App-owned ingestion seam for a refinement created from a card's own Refine dialog. */
  onRefinementCreated?: (task: Task) => void;
  onOpenGroupModal?: (groupId: string) => void;
  addToast: (message: string, type?: ToastType) => void;
  onQuickCreate?: (input: TaskCreateInput) => Promise<Task | void>;
  autoMerge?: boolean;
  /** Project merge strategy for Task Detail-equivalent card context actions. */
  mergeStrategy?: string;
  /* FNXC:TaskQueueOrder 2026-09-17-12:07: FN-509 removed the header overflow menu's auto-approve
     shortcut along with that menu. The project approval setting itself is unchanged and still
     lives in Settings. */
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[]; githubTracking?: { enabled?: boolean } }
  ) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onOpenChatWithPrefill?: (prefillText: string) => void;
  onRevertTask?: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
  /*
  FNXC:TaskRevert 2026-09-15-10:00 (FN-416):
  Reverted work is identified by a card label in its own column. Its resolution action is now a
  single context-menu entry — restore the revert — so that is what must reach the in-column card;
  the former Delete/Revise button pair and its `onReviseTask` prop are gone.
  */
  onRestoreRevertTask?: (id: string, body?: RestoreTaskRevertOptions) => Promise<RestoreTaskRevertResult>;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  /*
  FNXC:TaskQueueOrder 2026-09-17-12:07:
  FN-509 removed the per-column display-order props with the "…" menu that offered them. Ordering is
  now a single non-configurable policy shared by Board, Lane, and ListView; do not reintroduce a
  sort prop here, because a lane whose visible order can diverge from the queue order is exactly the
  confusion this change removes.
  */
  /**
   * FNXC:BoardColumnCount 2026-09-16-21:24: FN-475 — exact task count for THIS column only, never a
   * board-wide or collection-wide total. Supplied when a server-paged lane knows its own exact count
   * (a complete lane outside search); otherwise omitted so the badge falls back to the loaded cards
   * of this column.
   */
  totalTaskCount?: number;
  serverHasMore?: boolean;
  serverLoadingMore?: boolean;
  serverPaginationError?: "timeout" | "invalid-continuation" | "request-failed" | null;
  serverProgressKey?: string;
  paginationCollectionKey?: string;
  paginationActive?: boolean;
  onLoadMoreServer?: () => Promise<void>;
  onRetryServer?: () => Promise<void>;
  allTasks?: Task[];
  availableModels?: ModelInfo[];
  /**
   * Called when the user clicks the "Plan" button in the inline create card.
   */
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => void;
  favoriteProviders?: string[];
  favoriteModels?: string[];
  onToggleFavorite?: (provider: string) => void;
  onToggleModelFavorite?: (modelId: string) => void;
  /** When true, search is active — bypass pagination so all matching tasks are visible. */
  isSearchActive?: boolean;
  /** Called when user clicks a mission badge on a task card */
  onOpenMission?: (missionId: string) => void;
  /** Timestamp (ms) when task data was last confirmed fresh from the server. Used for freshness-aware stuck detection. */
  lastFetchTimeMs?: number;
  /** Per-task card-placed custom field definitions (U13/KTD-14). */
  taskCardFieldDefs?: ReadonlyMap<string, import("../api").WorkflowFieldDefinition[]>;
  /** Trusted aggregate-board workflow badges keyed by task id; omitted in per-workflow and non-board surfaces. */
  taskWorkflowBadges?: ReadonlyMap<string, { workflowId: string; workflowName: string; workflowIcon?: string }>;
  /** Precomputed blocker fanout keyed by blocker task ID. */
  blockerFanoutMap?: ReadonlyMap<string, BlockerFanoutEntry>;
  /** Whether GitHub CLI auth is available for creating PRs from task cards. */
  prAuthAvailable?: boolean;
  // ── U9 workflow-columns (flag-ON) additive props ─────────────────────────
  /** True when the board is in multi-lane workflow mode. Switches column behavior from legacy ids to trait flags. */
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
  The ids of tasks whose own column is a hold lane in THEIR OWN workflow, for the worktree
  grouping's upcoming-work list. Task ids rather than column ids because column ids are
  namespaced per workflow and two workflows can disagree about the same name (PR #2625
  review). Board resolves it; Lane does not pass it and keeps the legacy-id fallback.
  */
  holdTaskIds?: ReadonlySet<string>;
  workflowMode?: boolean;
  /** Workflow id for column-aware task creation in workflow mode. */
  workflowId?: string;
  /** Real workflow choices for the quick-add selector in workflow mode. */
  workflowOptions?: BoardWorkflowDefinition[];
  /** Default workflow target for quick-add when the parent view is aggregate or stale. */
  defaultWorkflowId?: string | null;
  /** Display name for this column, from the workflow definition. */
  columnDisplayName?: string;
  /** Optional explanatory copy from the workflow definition. */
  columnDescription?: string;
  /** Resolved trait flags for this column (workflow mode). */
  columnFlags?: BoardWorkflowColumnFlags;
  /** Ordered workflow columns for deriving context-menu move targets in workflow mode. */
  workflowContextMenuColumns?: readonly TaskContextMenuColumnMetadata[];
  /** Per-task workflow columns for aggregate Board cards whose tasks come from different workflows. */
  taskContextMenuColumnsByTaskId?: ReadonlyMap<string, readonly TaskContextMenuColumnMetadata[]>;
  /** Opens the existing History route. */
  onOpenHistory?: () => void;
}

function ColumnComponent({ column, tasks, projectId, maxWorktrees, showWorktreeGrouping, onOpenHistory, onMoveTask, onBoostTask, onPauseTask, onUnpauseTask, onResetTask, onDuplicateTask, onMergeTask, onOpenDetail, onRefinementCreated, onOpenGroupModal, addToast, onQuickCreate, autoMerge, mergeStrategy = "direct", globalPaused, onUpdateTask, onRetryTask, onOpenChatWithPrefill, onRevertTask, onRestoreRevertTask, onDeleteTask, totalTaskCount, serverHasMore, serverLoadingMore, serverPaginationError, serverProgressKey, paginationCollectionKey, paginationActive = true, onLoadMoreServer, onRetryServer, allTasks, availableModels, onPlanningMode, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, isSearchActive, onOpenMission, lastFetchTimeMs, taskCardFieldDefs, taskWorkflowBadges, blockerFanoutMap, prAuthAvailable, holdTaskIds, workflowMode, workflowId, workflowOptions, defaultWorkflowId, columnDisplayName, columnDescription, columnFlags, workflowContextMenuColumns, taskContextMenuColumnsByTaskId }: ColumnProps) {
  const { t } = useTranslation("app");
  // Anchor the board.rejection.* catalog keys for the i18next extractor (it
  // scopes `t` to the useTranslation binding, so the shared translateRejection
  // helper's calls are not statically discovered). These resolve the same copy.
  const rejectionCopy = useMemo(() => ({
    guardRejected: t("board.rejection.guardRejected", "This move is not allowed by the workflow."),
    capacityExhausted: t("board.rejection.capacityExhausted", "That column is at capacity. Try again when a slot frees up."),
    unknownColumn: t("board.rejection.unknownColumn", "That column doesn't exist in this task's workflow."),
    workflowMismatch: t("board.rejection.workflowMismatch", "Drag can't move a card between workflows. Use the workflow switcher instead."),
    mergeBlocked: t("board.rejection.mergeBlocked", "This task is blocked from completing until its merge step finishes."),
    staleMovePrecondition: t("board.rejection.staleMovePrecondition", "This card already moved on. Refresh to see where it is now."),
  }), [t]);
  void rejectionCopy;
  /*
  FNXC:TaskQueueOrder 2026-09-17-12:07:
  FN-509 REMOVED the column "…" menu, so the menu-open flag, its outside-click/Escape listeners, its
  container ref, and the two bulk-action busy flags are gone with it. The display order is now fixed
  (see `sortTasksForDisplayColumn`), so there is nothing left for a per-column menu to configure.

  The individual task operations the menu used to batch — replan, pause — and their endpoints are
  untouched; only the column-level shortcuts are retired. History and the Auto-merge toggle were
  always independent header controls and stay exactly where they were.
  */
  /*
  FNXC:WorkflowColumnDescriptions 2026-07-22-12:30:
  Whitespace-only values can exist in pre-editor/custom IR. Treat them as
  absent so they retain lifecycle fallback rather than creating a blank shell.
  */
  const resolvedColumnDescription = columnDescription?.trim() ? columnDescription : COLUMN_DESCRIPTIONS[column];
  /* DELIBERATE-LITERAL: the `column === "done"` is intentional as the degraded fallback when not in
     workflow mode and the column flags resolver is unavailable — `done` is the built-in Complete id. */
  const isCompleteColumn = columnFlags?.complete === true || (!workflowMode && column === "done");
  const displayedTaskCount = totalTaskCount ?? tasks.length;
  const countFlashing = useFlashOnIncrease(displayedTaskCount);
  const getTaskContextMenuColumns = useCallback((task: Task) => (
    taskContextMenuColumnsByTaskId?.get(task.id) ?? workflowContextMenuColumns
  ), [taskContextMenuColumnsByTaskId, workflowContextMenuColumns]);
  const getTaskColumnFlags = useCallback((task: Task) => (
    getTaskContextMenuColumns(task)?.find((candidate) => candidate.id === task.column)?.flags ?? (task.column === column ? columnFlags : undefined)
  ), [column, columnFlags, getTaskContextMenuColumns]);
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:55:
  HOISTED so `getTaskColumnFlags` can be a DEPENDENCY below, not merely a closed-over value.

  It previously sat after this callback, with a note observing that the body only runs during render
  so the const is initialised by then. That is true of the BODY and false of the dependency array,
  which evaluates eagerly — so the reference could not be listed, and the callback silently kept the
  closure built during the PRE-LOAD render, over an empty trait map. The note reasoned about
  declaration order and nothing about staleness, which is how it read as considered.

  Both callbacks close over props only, so the move is mechanical: no behaviour rides on it beyond
  making the dependency expressible.
  */
  const resolveNearDuplicateCanonicalInactive = useCallback((task: Task): boolean | undefined => {
    const nearDuplicateOf = task.sourceMetadata?.nearDuplicateOf;
    if (typeof nearDuplicateOf !== "string" || !allTasks) {
      return undefined;
    }
    const canonical = allTasks.find((candidate) => candidate.id === nearDuplicateOf);
    /* The canonical's OWN flags — a different task from the card being rendered, so this must not
       reuse the row's flags. */
    return isNearDuplicateCanonicalInactive(canonical, canonical ? getTaskColumnFlags(canonical) : undefined);
  }, [allTasks, getTaskColumnFlags]);

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-00:10 (fleet — one role question, one answer):
  The shared role helpers replace the `workflowMode ? trait : literal` ternaries.

  They are NOT identical, and the difference is the point. `workflowMode` is a BOARD-level boolean
  (`Boolean(boardWorkflows?.workflows.length)`) standing in for a PER-COLUMN question, so when the
  board is in workflow mode but THIS column has no resolved traits — a column the workflow no longer
  declares, which is exactly what a mid-flight workflow edit leaves behind — the old form answered
  `false` for every role. Not "fall back to the id": no role at all, so promote and bulk
  affordances silently vanished from that column.

  The helpers ask per column and fall back to the legacy id only when the flags are genuinely absent,
  which also covers the pre-load window the old form handled via `workflowMode === false`. Deliberate
  behaviour change, documented rather than silent; covered by column-role-degraded-flags.test.ts.
  */
  const isWipProcessingColumn = isWipColumnRole(columnFlags, column);
  /*
  FNXC:WorktreeGroupingSetting 2026-06-27-22:30:
  The project setting is an explicit show/hide control: worktree grouping and labels render only when enabled and only for the board's WIP/processing column. Turning it off must leave plain task cards with no legacy group shell in either legacy or workflow-mode columns.
  */
  const showWorktreeGroups = showWorktreeGrouping === true && isWipProcessingColumn;
  /*
  FNXC:BoardColumnCount 2026-09-16-20:37:
  Operator requirement: the column header shows ONLY the number of tasks in that lane (e.g. `4`),
  never an `executing/total` ratio. The executing half was judged noisy — it duplicated signal that
  already reads better on the cards themselves — so every column role (complete, WIP, hold, intake,
  review, custom workflow lane) now renders the same single count with an `N tasks` aria-label.
  The former header↔card-glow agreement constraint no longer applies to the header: the card glow
  keeps its own shared predicate (`isTaskAgentActive` -> `isRunningAgentTask`) and the footer keeps
  the live-agent Running population, so neither surface loses its meaning.
  */
  /*
  FNXC:BoardColumnWindowing 2026-09-07-16:03:
  Every ordinary Board lane mounts only its measured viewport window, including search results. The result signature resets geometry when a different search collection arrives; worktree grouping remains exempt because its provider is already bounded by execution capacity.
  */
  const stableCollectionKey = paginationCollectionKey ?? `${projectId ?? "default"}:${column}:${isSearchActive ? "search" : "board"}`;

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-20:10 (PR #2772 review — my own inert conversion):
  The dependency flags `groupByWorktree` needs, derived from the per-task column metadata this
  component already receives.

  I gave `groupByWorktree` a `dependencyColumnFlags` parameter and then left this — its only board
  caller — passing four arguments. So `depFlags` was always undefined, every dependency fell to the
  legacy-id branch, and the conversion changed nothing while the census counted it. Exactly the
  half-conversion I have been flagging in other people's work; caught here by review, not by me.

  Keyed by the DEPENDENCY's task id, holding the flags of the column that task is currently in —
  the same derivation ListView's `getTaskColumnFlags` uses, and per-task rather than per-column-id so
  two workflows reusing an id cannot answer for each other.
  */
  const dependencyColumnFlags = useMemo(() => {
    const index = new Map<string, TaskContextMenuColumnMetadata["flags"]>();
    if (!taskContextMenuColumnsByTaskId) return index;
    for (const candidate of allTasks ?? tasks) {
      const own = taskContextMenuColumnsByTaskId.get(candidate.id);
      if (!own) continue;
      index.set(candidate.id, own.find((entry) => entry.id === candidate.column)?.flags);
    }
    return index;
  }, [allTasks, tasks, taskContextMenuColumnsByTaskId]);

  /*
  FNXC:CapacityModel 2026-08-21-15:45:
  FN-282 requires the board's Up Next preview to use execution-worktree capacity rather than the independent AI-task ceiling.
  The configured max can be shadowed by an enabled worktree cap, so showing it here would promise slots the scheduler cannot grant.
  */
  const worktreeGroups = useMemo(() => {
    if (!showWorktreeGroups) return [];
    return groupByWorktree(tasks, allTasks ?? tasks, maxWorktrees, holdTaskIds, dependencyColumnFlags);
    // `holdTaskIds` IS a dependency: the board resolves it after the workflows fetch, so
    // omitting it would pin the first-paint value and the upcoming-work list would keep
    // using the legacy-id fallback for the rest of the session. This repo has no
    // react-hooks/exhaustive-deps rule, so nothing catches that but reading it.
  }, [showWorktreeGroups, tasks, allTasks, maxWorktrees, holdTaskIds, dependencyColumnFlags]);

  const columnBodyRef = useRef<HTMLDivElement | null>(null);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  /*
  FNXC:BoardNavigation 2026-09-09-22:29:
  Every lane virtualizer starts at the first task. Board additionally replays a scroll event at each arrival boundary so a retained Column cannot keep terminal geometry, while later task refreshes leave user-owned scrolling untouched.
  */
  /*
  FNXC:BoardNavigation 2026-09-09-22:29:
  Board lanes always initialize their virtual window at the first task. Board's arrival boundary may also reset an already-mounted lane and dispatch scroll; keep this local alignment at start, while ordinary task refreshes remain free to preserve the user's later position.
  */
  const virtualList = useVirtualizedList({
    collectionKey: stableCollectionKey,
    keys: showWorktreeGroups ? [] : tasks.map((task) => task.id),
    scrollRef: columnBodyRef,
    estimateHeight: 320,
    maxRenderedRows: 40,
    initialAlign: "start",
    followStartOnPrepend: isCompleteColumn,
  });
  const visibleTasks = showWorktreeGroups
    ? tasks
    : virtualList.visibleKeys.flatMap((id) => {
        const task = taskById.get(id);
        return task ? [task] : [];
      });
  const autoPagination = useAutoPaginationSentinel({
    rootRef: columnBodyRef,
    hasMore: Boolean(serverHasMore),
    loading: Boolean(serverLoadingMore),
    onLoadMore: onLoadMoreServer ?? (() => undefined),
    direction: "end",
    enabled: paginationActive && !showWorktreeGroups && !serverPaginationError,
    progressKey: serverProgressKey,
    collectionKey: stableCollectionKey,
  });
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-19:45 (Phase B — third attempt, this time with the
  fixtures migrated instead of the arm defended):
  The `|| column === "triage"` arm was the LEGACY-board path: before workflow lanes, only the
  hardcoded intake column offered inline create. U12 deleted the legacy board, Board is Column's
  only consumer, and it passes `workflowMode` at all three render sites — so the arm is unreachable
  in production.

  I deleted it twice before and reverted both times, because four Column tests render without
  `workflowMode` and went red. That was the delete-only rule working: a behaviour change means the
  branch was not dead FOR THOSE CALLERS. The callers in question are fixtures, not production, so
  the honest fix is to migrate them to the shape Board actually uses rather than keep an arm alive
  to satisfy them. Done in Column.test.tsx alongside this.

  Deliberately NOT solved by defaulting `workflowMode` to true: role-dependent behavior shares that
  flag, so a global default would silently reinterpret every other fixture in the file.
  */
  const canCreateInColumn = Boolean(onQuickCreate && workflowMode);

  const handleQuickCreate = useCallback(
    (input: TaskCreateInput) => {
      if (!onQuickCreate) return Promise.resolve();
      if (workflowMode) {
        /*
        FNXC:QuickAddStart 2026-07-22-17:45:
        The Quick Add Start intent may carry a workflow-validated initial Todo column.
        Preserve that explicit create destination; ordinary Save has no column and continues
        to inherit this rendered intake column.
        */
        return onQuickCreate({
          ...input,
          column: input.column ?? column,
          ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : (workflowId ? { workflowId } : {})),
        });
      }
      return onQuickCreate(input);
    },
    [column, onQuickCreate, workflowId, workflowMode],
  );

  /*
  FNXC:TaskQueueOrder 2026-09-17-12:07:
  FN-509 removed the column "…" menu and with it the column-level Replan All / Stop All shortcuts and
  the per-column sort control. The individual task operations and their endpoints are untouched —
  only the batch entry point is gone.

  FNXC:HumanMergeApproval 2026-09-17-18:09:
  FN-514 removed the review-lane merge control that used to live here, so this header no longer needs
  the review-lane role at all: nothing it renders is lane-conditional any more.
  */

  return (
    <UiSurface
      className="column"
      data-column={column}
    >
      <div className="column-header">
        <div className={`column-dot dot-${column}`} />
        <h2>{workflowMode ? (columnDisplayName ?? COLUMN_LABELS[column] ?? column) : (COLUMN_LABELS[column] ?? column)}</h2>
        <span
          className={`column-count${countFlashing ? " count-flash" : ""}`}
          aria-label={t("column.taskCount", "{{total}} tasks", { total: displayedTaskCount.toLocaleString() })}
        >
          <span>{displayedTaskCount.toLocaleString()}</span>
        </span>
        {/* FNXC:NativeShell 2026-09-09-18:24: Every resolved complete lane, including custom empty lanes, owns the sole History entry point. */}
        {isCompleteColumn && onOpenHistory && (
          <UiButton
            type="button"
            className="btn btn-icon btn-sm column-history-button"
            onClick={onOpenHistory}
            aria-label={t("column.openHistory", "Open History")}
            title={t("column.openHistory", "Open History")}
            data-testid={`column-history-${column}`}
          >
            <History />
          </UiButton>
        )}
        {/* FNXC:OfficialDashboardDesign 2026-09-13-00:38: The Header owns the sole New Task action, so column headers retain no duplicate button or click shell. */}
        {/*
        FNXC:HumanMergeApproval 2026-09-17-18:09:
        FN-514 REMOVED the review column's Auto-merge toggle. It was a project-wide switch sitting on a
        lane header, which could not answer the question an operator actually has about ONE card, and
        flipping it silently changed every other card's delivery. The per-task delivery lock replaces
        it: armed at creation or from the card's own menu, and decided in Task Detail with «Créer PR»,
        «Merger» or «Refuser».

        What was deliberately NOT removed: the project Auto-merge SETTING itself, the PR/branch-group
        policies, and existing per-task `autoMerge` overrides. They keep their meaning and are still
        edited in Settings; only this lane-header control is gone. No empty label, input, slider,
        title or aria-label survives it — the header now ends with the History button.

        The shared toggle styles remain in styles.css because the plan-approval control still uses
        them; deleting them would break an unrelated affordance.
        */}
        {/* FNXC:TaskQueueOrder 2026-09-17-12:07: FN-509 removed the column "…" menu. No empty button
            shell, click target, popover container, or aria-label survives it. */}
      </div>
      {resolvedColumnDescription && (
        <p className="column-desc">{resolvedColumnDescription}</p>
      )}
      <div className="column-body" ref={columnBodyRef} onScroll={virtualList.onScroll}>
          {canCreateInColumn && (
            <QuickEntryBox 
              onCreate={handleQuickCreate}
              onMoveTask={onMoveTask}
              addToast={addToast} 
              tasks={allTasks ?? []}
              availableModels={availableModels}
              onPlanningMode={onPlanningMode}
                            workflowId={workflowMode ? workflowId : undefined}
              workflowOptions={workflowMode ? workflowOptions : undefined}
              defaultWorkflowId={workflowMode ? defaultWorkflowId : undefined}
              projectId={projectId}
              autoExpand={false}
              /*
              FNXC:NativeQuickEntry 2026-09-15-00:20:
              Board columns keep the compact composer: only the immediate-action row is visible and advanced
              routing options disclose on demand. This used to come from the presentation perimeter; it is now
              an explicit host choice, so the rendered result is identical without any feature flag.
              */
              defaultExpanded={false}
              favoriteProviders={favoriteProviders}
              favoriteModels={favoriteModels}
              onToggleFavorite={onToggleFavorite}
              onToggleModelFavorite={onToggleModelFavorite}
              onOpenTask={(taskId) => {
                const matchingTask = (allTasks ?? []).find((candidate) => candidate.id === taskId);
                if (matchingTask) {
                  onOpenDetail(matchingTask);
                  return;
                }
                if (typeof window !== "undefined") {
                  window.location.hash = `#/tasks/${taskId}`;
                }
              }}
            />
          )}
          {showWorktreeGroups ? (
            worktreeGroups.length === 0 ? (
              <div className="empty-column">{t("column.noTasks", "No tasks")}</div>
            ) : (
              worktreeGroups.map((group) => (
                <WorktreeGroup
                  key={group.id}
                  kind={group.kind}
                  repoCount={group.repoCount}
                  label={group.label}
                  activeTasks={group.activeTasks}
                  queuedTasks={group.queuedTasks}
                  projectId={projectId}
                  onOpenDetail={onOpenDetail}
                  onRefinementCreated={onRefinementCreated}
                  workflowId={workflowMode ? workflowId : undefined}
                  onMoveTask={onMoveTask}
                  addToast={addToast}
                  globalPaused={globalPaused}
                  onUpdateTask={onUpdateTask}
                  onBoostTask={onBoostTask}
                  onPauseTask={onPauseTask}
                  onRetryTask={onRetryTask}
                  onOpenChatWithPrefill={onOpenChatWithPrefill}
                  onUnpauseTask={onUnpauseTask}
                  onResetTask={onResetTask}
                  onDuplicateTask={onDuplicateTask}
                  onMergeTask={onMergeTask}
                  onRevertTask={onRevertTask}
                  onRestoreRevertTask={onRestoreRevertTask}
                  onDeleteTask={onDeleteTask}
                  onOpenDetailWithTab={onOpenDetailWithTab}
                  onOpenMission={onOpenMission}
                  lastFetchTimeMs={lastFetchTimeMs}
                  taskCardFieldDefs={taskCardFieldDefs}
                  taskWorkflowBadges={taskWorkflowBadges}
                  blockerFanoutMap={blockerFanoutMap}
                  prAuthAvailable={prAuthAvailable}
                  autoMergeEnabled={Boolean(autoMerge)}
                  mergeStrategy={mergeStrategy}
                  workflowContextMenuColumns={workflowContextMenuColumns}
                  taskContextMenuColumnsByTaskId={taskContextMenuColumnsByTaskId}
                  allTasks={allTasks}
                />
              ))
            )
          ) : tasks.length === 0 ? (
            <div className="empty-column">{t("column.noTasks", "No tasks")}</div>
          ) : (
            <div className="column-virtual-content">
              {virtualList.topSpacerHeight > 0 ? <div className="column-virtual-spacer" aria-hidden="true" style={{ height: virtualList.topSpacerHeight }} /> : null}
              {visibleTasks.map((task) => (
                <div className="column-virtual-row" key={task.id} ref={virtualList.measureRow(task.id)} data-virtual-task-row={task.id}>
                <TaskCard
                  key={task.id}
                  task={task}
                  projectId={projectId}
                  onOpenDetail={onOpenDetail}
                  planningWorkflowId={workflowMode ? workflowId : taskWorkflowBadges?.get(task.id)?.workflowId ?? null}
                  onRefinementCreated={onRefinementCreated}
                  onOpenGroupModal={onOpenGroupModal}
                  addToast={addToast}
                  globalPaused={globalPaused}
                  onUpdateTask={onUpdateTask}
                  onBoostTask={onBoostTask}
                  onPauseTask={onPauseTask}
                  onRetryTask={onRetryTask}
                  onOpenChatWithPrefill={onOpenChatWithPrefill}
                  onUnpauseTask={onUnpauseTask}
                  onResetTask={onResetTask}
                  onDuplicateTask={onDuplicateTask}
                  onMergeTask={onMergeTask}
                  onRevertTask={onRevertTask}
                  onRestoreRevertTask={onRestoreRevertTask}
                  onDeleteTask={onDeleteTask}
                  onOpenDetailWithTab={onOpenDetailWithTab}
                  onOpenMission={onOpenMission}
                  onMoveTask={onMoveTask}
                  taskColumnFlags={getTaskColumnFlags(task)}
                  taskMoveColumns={getTaskContextMenuColumns(task)}
                  lastFetchTimeMs={lastFetchTimeMs}
                  cardFieldDefs={taskCardFieldDefs?.get(task.id)}
                  workflowBadge={taskWorkflowBadges?.get(task.id)}
                  fanout={blockerFanoutMap?.get(task.id)}
                  prAuthAvailable={prAuthAvailable}
                  autoMergeEnabled={Boolean(autoMerge)}
                  mergeStrategy={mergeStrategy}
                  nearDuplicateCanonicalInactive={resolveNearDuplicateCanonicalInactive(task)}
                />
                </div>
              ))}
              {virtualList.bottomSpacerHeight > 0 ? <div className="column-virtual-spacer" aria-hidden="true" style={{ height: virtualList.bottomSpacerHeight }} /> : null}
            </div>
          )}
          {(serverHasMore || serverPaginationError) ? (
            <div className="column-pagination-footer" ref={serverHasMore ? autoPagination.sentinelRef : undefined} role="status" aria-live="polite" data-testid="column-auto-pagination-sentinel">
              {serverLoadingMore ? t("column.loadMoreCompletedLoading", "Loading…") : null}
              {serverPaginationError ? (
                <div className="column-pagination-error">
                  <span>{t("column.paginationError", "Older tasks could not be loaded.")}</span>
                  <UiButton type="button" className="btn btn-sm" onClick={() => void onRetryServer?.()}>
                    {t("common.retry", "Retry")}
                  </UiButton>
                </div>
              ) : null}
            </div>
          ) : null}
          <PluginSlot slotId="board-column-footer" projectId={projectId} />
        </div>
    </UiSurface>
  );
}

export const Column = memo(ColumnComponent);
Column.displayName = "Column";
