import { memo, useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useFlashOnIncrease } from "../hooks/useFlashOnIncrease";
import { useConfirm } from "../hooks/useConfirm";
import type { Task, TaskDetail, Column as ColumnType, ColumnId, TaskCreateInput, GithubIssueAction, MergeResult } from "@fusion/core";
import { COLUMN_LABELS, COLUMN_DESCRIPTIONS, getErrorMessage } from "@fusion/core";
import { enrichRunningAgentTaskShapeFromFlags, isRunningAgentTask } from "../../../core/src/live-agent-count";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate-canonical";
import { TaskCard } from "./TaskCard";
import { WorktreeGroup } from "./WorktreeGroup";
import { QuickEntryBox } from "./QuickEntryBox";
import { PluginSlot } from "./PluginSlot";
import { groupByWorktree } from "../utils/worktreeGrouping";
import type { ToastType } from "../hooks/useToast";
import type { TaskContextMenuColumnMetadata } from "./TaskContextMenu";
import { ChevronDown, ChevronUp, MoreVertical } from "lucide-react";
import type { BoardWorkflowDefinition, ModelInfo, BoardWorkflowColumnFlags, RevertTaskOptions, RevertTaskResult } from "../api";
import type { BlockerFanoutEntry } from "../hooks/useBlockerFanout";
import type { DoneColumnSortMode } from "./taskSorting";

const PAGINATED_COLUMN_THRESHOLD = 100;
const VISIBLE_TASKS_INITIAL = 50;
const VISIBLE_TASKS_INCREMENT = 25;

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
    default:
      return t(messageKey, messageKey);
  }
}

interface ColumnProps {
  column: ColumnType;
  tasks: Task[];
  projectId?: string;
  maxConcurrent: number;
  showWorktreeGrouping: boolean;
  onMoveTask: (id: string, column: ColumnId, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  onPauseTask?: (id: string) => Promise<Task>;
  onUnpauseTask?: (id: string) => Promise<Task>;
  onResetTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  onMergeTask?: (id: string) => Promise<MergeResult>;
  onOpenDetail: (task: Task | TaskDetail) => void;
  onOpenRefine?: (task: Task | TaskDetail) => void;
  onOpenGroupModal?: (groupId: string) => void;
  addToast: (message: string, type?: ToastType) => void;
  onQuickCreate?: (input: TaskCreateInput) => Promise<Task | void>;
  onNewTask?: () => void;
  autoMerge?: boolean;
  /** Project merge strategy for Task Detail-equivalent card context actions. */
  mergeStrategy?: string;
  onToggleAutoMerge?: () => void;
  planAutoApproveEnabled?: boolean;
  onTogglePlanAutoApprove?: () => void;
  globalPaused?: boolean;
  onUpdateTask?: (
    id: string,
    updates: { title?: string; description?: string; dependencies?: string[]; githubTracking?: { enabled?: boolean } }
  ) => Promise<Task>;
  onRetryTask?: (id: string) => Promise<Task>;
  onArchiveTask?: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  onUnarchiveTask?: (id: string) => Promise<Task>;
  /* FNXC:TaskRevert 2026-07-05-00:00 (FN-7525): threaded alongside onArchiveTask/onUnarchiveTask. */
  onRevertTask?: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  onArchiveAllDone?: () => Promise<Task[]>;
  /** Current Done-column display order, supplied only for the board's Done surface. */
  doneSortMode?: DoneColumnSortMode;
  /** Updates the board-local Done-column display order. */
  onDoneSortModeChange?: (mode: DoneColumnSortMode) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** FNXC:ArchivePagination 2026-07-08-00:00: FN-7659 — whether another archived page (beyond what's currently loaded) is available. Drives the archived column's server-backed "Show more" button. */
  archivedHasMore?: boolean;
  /** True while a "Show more" archived page fetch is in flight. */
  archivedLoadingMore?: boolean;
  /** Fetches the next 100-item page of archived tasks (newest-first). */
  onLoadMoreArchived?: () => Promise<void>;
  allTasks?: Task[];
  availableModels?: ModelInfo[];
  /**
   * Called when the user clicks the "Plan" button in the inline create card.
   */
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  /**
   * Called when the user clicks the "Subtask" button in the inline create card.
   */
  onSubtaskBreakdown?: (description: string, workflowId?: string | null) => void;
  onOpenDetailWithTab?: (task: Task | TaskDetail, initialTab: "changes" | "retries" | "workflow") => void;
  favoriteProviders?: string[];
  favoriteModels?: string[];
  onToggleFavorite?: (provider: string) => void;
  onToggleModelFavorite?: (modelId: string) => void;
  /** When true, search is active — bypass pagination so all matching tasks are visible. */
  isSearchActive?: boolean;
  /** Project-level stuck task timeout in milliseconds (undefined = disabled) */
  taskStuckTimeoutMs?: number;
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
  /** True when the board is in multi-lane workflow mode (flag ON). Switches
   *  column behavior (label, bulk actions, archived detection) from legacy
   *  literals to trait-flag predicates. Flag OFF leaves all behavior legacy. */
  workflowMode?: boolean;
  /** Workflow id for column-aware task creation in workflow mode. */
  workflowId?: string;
  /** Real workflow choices for the quick-add selector in workflow mode. */
  workflowOptions?: BoardWorkflowDefinition[];
  /** Default workflow target for quick-add when the parent view is aggregate or stale. */
  defaultWorkflowId?: string | null;
  /** Display name for this column, from the workflow definition. */
  columnDisplayName?: string;
  /** Resolved trait flags for this column (workflow mode). */
  columnFlags?: BoardWorkflowColumnFlags;
  /** Ordered workflow columns for deriving context-menu move targets in workflow mode. */
  workflowContextMenuColumns?: readonly TaskContextMenuColumnMetadata[];
  /** Per-task workflow columns for aggregate Board cards whose tasks come from different workflows. */
  taskContextMenuColumnsByTaskId?: ReadonlyMap<string, readonly TaskContextMenuColumnMetadata[]>;
  /** Manually promote a held card out of this hold column (workflow mode). */
  onPromote?: (taskId: string) => Promise<void>;
  /**
   * Pre-check whether a drop into THIS column is allowed for the dragged task.
   * Returns null for "allowed", or an i18n messageKey for a deterministic
   * rejection (guard/capacity/unknown-column/workflow-mismatch). When a
   * rejection is returned, dragover is NOT prevented, so the card never renders
   * in this column (no-move semantics, R17). The dragged task id is read from a
   * board-level ref set on dragstart.
   */
  canDropTask?: (taskId: string) => string | null;
  /** Read the id of the task currently being dragged (board-level ref). */
  getDraggingTaskId?: () => string | null;
}

function ColumnComponent({ column, tasks, projectId, maxConcurrent, showWorktreeGrouping, onMoveTask, onPauseTask, onUnpauseTask, onResetTask, onDuplicateTask, onMergeTask, onOpenDetail, onOpenRefine, onOpenGroupModal, addToast, onQuickCreate, onNewTask, autoMerge, mergeStrategy = "direct", onToggleAutoMerge, planAutoApproveEnabled, onTogglePlanAutoApprove, globalPaused, onUpdateTask, onRetryTask, onArchiveTask, onUnarchiveTask, onRevertTask, onDeleteTask, onArchiveAllDone, doneSortMode, onDoneSortModeChange, collapsed, onToggleCollapse, archivedHasMore, archivedLoadingMore, onLoadMoreArchived, allTasks, availableModels, onPlanningMode, onSubtaskBreakdown, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, isSearchActive, taskStuckTimeoutMs, onOpenMission, lastFetchTimeMs, taskCardFieldDefs, taskWorkflowBadges, blockerFanoutMap, prAuthAvailable, workflowMode, workflowId, workflowOptions, defaultWorkflowId, columnDisplayName, columnFlags, workflowContextMenuColumns, taskContextMenuColumnsByTaskId, onPromote, canDropTask, getDraggingTaskId }: ColumnProps) {
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
    promoteRejected: t("board.rejection.promoteRejected", "This card could not be promoted."),
  }), [t]);
  void rejectionCopy;
  const [dragOver, setDragOver] = useState(false);
  const [visibleTaskCount, setVisibleTaskCount] = useState(VISIBLE_TASKS_INITIAL);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isReplanning, setIsReplanning] = useState(false);
  const [isPausingAll, setIsPausingAll] = useState(false);
  const [isMovingAllToTodo, setIsMovingAllToTodo] = useState(false);
  // Workflow mode: per-card promote in-flight ids + inline capacity feedback.
  const [promotingIds, setPromotingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [inlineFeedback, setInlineFeedback] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const countFlashing = useFlashOnIncrease(tasks.length);
  const { confirm } = useConfirm();
  const resolveNearDuplicateCanonicalInactive = useCallback((task: Task): boolean | undefined => {
    const nearDuplicateOf = task.sourceMetadata?.nearDuplicateOf;
    if (typeof nearDuplicateOf !== "string" || !allTasks) {
      return undefined;
    }
    return isNearDuplicateCanonicalInactive(allTasks.find((candidate) => candidate.id === nearDuplicateOf));
  }, [allTasks]);

  // Clear the inline capacity-exhausted banner once the column's task list
  // changes via SSE (e.g. an occupant moves out and capacity frees up). The
  // banner reflects a point-in-time promote rejection; a changed roster means
  // the stale constraint may no longer hold. Keyed on the task-id signature so
  // it only fires on real membership changes, not every parent re-render.
  const taskIdSignature = useMemo(() => tasks.map((task) => task.id).join(","), [tasks]);
  useEffect(() => {
    setInlineFeedback(null);
  }, [taskIdSignature]);

  // Close the column dropdown menu when the user clicks anywhere else.
  useEffect(() => {
    if (!isMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [isMenuOpen]);

  // Archived column is collapsed by default - don't show drag state when collapsed.
  // Workflow mode keys off the resolved `archived` trait flag instead of the
  // literal column id (R9). A hold-flagged column shows the promote affordance.
  const isArchived = workflowMode ? Boolean(columnFlags?.archived) : column === "archived";
  const isHoldColumn = workflowMode && Boolean(columnFlags?.hold);
  const isCollapsed = isArchived && collapsed;
  const isWipProcessingColumn = workflowMode ? Boolean(columnFlags?.countsTowardWip) : column === "in-progress";
  const getTaskContextMenuColumns = useCallback((task: Task) => (
    taskContextMenuColumnsByTaskId?.get(task.id) ?? workflowContextMenuColumns
  ), [taskContextMenuColumnsByTaskId, workflowContextMenuColumns]);
  const getTaskColumnFlags = useCallback((task: Task) => (
    getTaskContextMenuColumns(task)?.find((candidate) => candidate.id === task.column)?.flags ?? (task.column === column ? columnFlags : undefined)
  ), [column, columnFlags, getTaskContextMenuColumns]);
  /*
  FNXC:WorktreeGroupingSetting 2026-06-27-22:30:
  The project setting is an explicit show/hide control: worktree grouping and labels render only when enabled and only for the board's WIP/processing column. Turning it off must leave plain task cards with no legacy group shell in either legacy or workflow-mode columns.
  */
  const showWorktreeGroups = showWorktreeGrouping === true && isWipProcessingColumn;
  /*
  FNXC:BoardColumnCount 2026-07-21-19:30:
  Column header is executing/total (e.g. 3/4). Executing uses the same Running predicate as the
  footer (unpaused WIP, live planners, active review). Total is the card count in this lane.
  */
  const activeTaskCount = useMemo(
    () => tasks.filter((task) => isRunningAgentTask(enrichRunningAgentTaskShapeFromFlags(task, columnFlags))).length,
    [tasks, columnFlags],
  );
  // When search is active, skip pagination so all matching tasks are visible
  const shouldPaginate = !isArchived && !isSearchActive && !showWorktreeGroups && tasks.length > PAGINATED_COLUMN_THRESHOLD;

  useEffect(() => {
    setVisibleTaskCount((current) => {
      if (showWorktreeGroups || isArchived || tasks.length <= PAGINATED_COLUMN_THRESHOLD) {
        return VISIBLE_TASKS_INITIAL;
      }

      return Math.min(Math.max(current, VISIBLE_TASKS_INITIAL), tasks.length);
    });
  }, [showWorktreeGroups, isArchived, tasks.length]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    // Don't allow dropping into archived column via drag-drop
    if (isArchived) return;
    // Workflow mode (R17): deterministic rejections are NO-MOVE — we do NOT
    // call preventDefault, so the browser refuses the drop and the card never
    // renders in this column. A null result means the drop is allowed.
    if (workflowMode && canDropTask && getDraggingTaskId) {
      const draggingId = getDraggingTaskId();
      if (draggingId) {
        const rejectionKey = canDropTask(draggingId);
        if (rejectionKey) {
          setInlineFeedback(translateRejectionKey(t, rejectionKey));
          return; // no preventDefault → no-move
        }
      }
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(true);
  }, [isArchived, workflowMode, canDropTask, getDraggingTaskId, t]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (!el.contains(e.relatedTarget as Node)) {
      setDragOver(false);
      setInlineFeedback(null);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const taskId = e.dataTransfer.getData("text/plain");
    if (!taskId) return;

    // Check if task is already in this column - if so, skip the API call
    const task = tasks.find((t) => t.id === taskId);
    if (task && task.column === column) {
      return; // No-op: task is already in this column
    }

    try {
      const sourceTask = allTasks?.find((t) => t.id === taskId) ?? task;
      const hasStepProgress = sourceTask?.steps.some((step) => step.status !== "pending") ?? false;
      const shouldPrompt = (column === "todo" || column === "triage") && hasStepProgress;
      let moveOptions: { preserveProgress?: boolean } | undefined;

      if (shouldPrompt) {
        const keepProgress = await confirm({
          title: t("column.preserveProgressTitle", "Preserve Progress?"),
          message: t("column.preserveProgressMessage", "This task has completed steps. Keep progress before moving?"),
          confirmLabel: t("column.keepProgress", "Keep Progress"),
          cancelLabel: t("column.resetProgress", "Reset Progress"),
        });

        if (keepProgress) {
          moveOptions = { preserveProgress: true };
        } else {
          const resetProgress = await confirm({
            title: t("column.resetProgressTitle", "Reset Progress?"),
            message: t("column.resetProgressMessage", "Reset all step progress before moving this task?"),
            confirmLabel: t("column.resetProgressConfirm", "Reset Progress"),
            cancelLabel: t("column.cancelMove", "Cancel Move"),
            danger: true,
          });
          if (!resetProgress) {
            return;
          }
        }
      }

      await onMoveTask(taskId, column, moveOptions);
    } catch (err) {
      // Workflow mode (R17): a structured 409 carries a typed rejection. The
      // optimistic move snaps back automatically (the next SSE/refresh restores
      // the card's real column); surface the translated rejection messageKey.
      const rejection = extractTransitionRejection(err);
      if (rejection) {
        addToast(translateRejection(t, rejection), "error");
      } else {
        addToast(getErrorMessage(err), "error");
      }
    }
  }, [addToast, allTasks, column, confirm, onMoveTask, tasks, t]);

  const handlePromote = useCallback(async (taskId: string) => {
    if (!onPromote) return;
    setInlineFeedback(null);
    setPromotingIds((prev) => {
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
    try {
      await onPromote(taskId);
    } catch (err) {
      const rejection = extractTransitionRejection(err);
      if (rejection) {
        // Capacity-exhausted (and any rejection) shows INLINE column feedback,
        // not a toast — so multiple holds can promote concurrently without spam.
        setInlineFeedback(translateRejection(t, rejection));
      } else {
        setInlineFeedback(getErrorMessage(err));
      }
    } finally {
      setPromotingIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }, [onPromote, t]);

  const worktreeGroups = useMemo(() => {
    if (!showWorktreeGroups) return [];
    return groupByWorktree(tasks, allTasks ?? tasks, maxConcurrent);
  }, [showWorktreeGroups, tasks, allTasks, maxConcurrent]);

  const visibleTasks = useMemo(() => {
    if (!shouldPaginate) return tasks;
    return tasks.slice(0, visibleTaskCount);
  }, [shouldPaginate, tasks, visibleTaskCount]);

  const hiddenTaskCount = Math.max(0, tasks.length - visibleTasks.length);
  const canCreateInColumn = Boolean(
    onQuickCreate &&
    !isArchived &&
    (workflowMode || column === "triage"),
  );

  const handleQuickCreate = useCallback(
    (input: TaskCreateInput) => {
      if (!onQuickCreate) return Promise.resolve();
      if (workflowMode) {
        return onQuickCreate({
          ...input,
          column,
          ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : (workflowId ? { workflowId } : {})),
        });
      }
      return onQuickCreate(input);
    },
    [column, onQuickCreate, workflowId, workflowMode],
  );

  const handleLoadMore = useCallback(() => {
    setVisibleTaskCount((current) => Math.min(current + VISIBLE_TASKS_INCREMENT, tasks.length));
  }, [tasks.length]);

  /*
  FNXC:ArchivePagination 2026-07-08-00:00:
  FN-7659 — the Archived column's "Show more" is server-backed (fetches the
  next 100-item page ordered `archivedAt DESC` from the API), distinct from
  `handleLoadMore` above which only reveals more of an already-fetched
  client-side array for non-archived columns.
  */
  const [isLoadingMoreArchived, setIsLoadingMoreArchived] = useState(false);
  const handleLoadMoreArchived = useCallback(async () => {
    if (!onLoadMoreArchived || isLoadingMoreArchived) return;
    setIsLoadingMoreArchived(true);
    try {
      await onLoadMoreArchived();
    } finally {
      setIsLoadingMoreArchived(false);
    }
  }, [onLoadMoreArchived, isLoadingMoreArchived]);

  const handleReplanAll = useCallback(async () => {
    setIsMenuOpen(false);
    if (tasks.length === 0) return;

    const confirmed = await confirm({
      title: t("column.replanAllTitle", "Replan All Tasks"),
      message: t("column.replanAllMessage", "Move all {{count}} todo task{{plural}} back to planning to be replanned?", { count: tasks.length, plural: tasks.length === 1 ? "" : "s" }),
    });
    if (!confirmed) return;

    setIsReplanning(true);
    try {
      // Issue moves in parallel — onMoveTask is per-task, no bulk endpoint.
      const results = await Promise.allSettled(
        tasks.map((task) => onMoveTask(task.id, "triage" as ColumnType)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const moved = results.length - failed;
      if (failed === 0) {
        addToast(t("column.movedToPlanning", "Moved {{count}} task{{plural}} to planning for replanning", { count: moved, plural: moved === 1 ? "" : "s" }), "success");
      } else {
        addToast(t("column.movePartialFailure", "Moved {{moved}} of {{total}} tasks; {{failed}} failed", { moved, total: results.length, failed }), "error");
      }
    } finally {
      setIsReplanning(false);
    }
  }, [tasks, onMoveTask, addToast, confirm]);

  const pauseEligibleTasks = useMemo(
    () => tasks.filter((task) => !task.paused && !task.assignedAgentId),
    [tasks],
  );
  const pauseEligibleCount = pauseEligibleTasks.length;
  // Bulk-action eligibility (R9): workflow mode keys off trait flags instead of
  // the literal column ids. Todo-equivalent = hold/intake (replan affordance);
  // processing = wip/countsTowardWip; review = mergeBlocker/humanReview.
  const isTodoLikeColumn = workflowMode ? Boolean(columnFlags?.hold || columnFlags?.intake) : column === "todo";
  const isProcessingColumn = workflowMode ? Boolean(columnFlags?.countsTowardWip) : column === "in-progress";
  const isReviewColumn = workflowMode ? Boolean(columnFlags?.mergeBlocker || columnFlags?.humanReview) : column === "in-review";
  const hasColumnBulkActions = isTodoLikeColumn || isProcessingColumn || isReviewColumn;
  const isMenuBusy = isReplanning || isPausingAll || isMovingAllToTodo;
  const columnLabelText = workflowMode ? (columnDisplayName ?? COLUMN_LABELS[column] ?? column) : COLUMN_LABELS[column];

  const handlePauseAll = useCallback(async () => {
    if (!onPauseTask) return;

    setIsMenuOpen(false);
    if (pauseEligibleCount === 0) return;

    const confirmed = await confirm({
      title: t("column.stopAllTitle", "Stop All Tasks"),
      message: t("column.stopAllMessage", "Stop all {{count}} {{columnLabel}} task{{plural}}?", { count: pauseEligibleCount, columnLabel: columnLabelText.toLowerCase(), plural: pauseEligibleCount === 1 ? "" : "s" }),
      danger: true,
    });
    if (!confirmed) return;

    setIsPausingAll(true);
    try {
      const results = await Promise.allSettled(
        pauseEligibleTasks.map((task) => onPauseTask(task.id)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const paused = results.length - failed;
      if (failed === 0) {
        addToast(t("column.stoppedTasks", "Stopped {{count}} task{{plural}}", { count: paused, plural: paused === 1 ? "" : "s" }), "success");
      } else {
        addToast(t("column.stopPartialFailure", "Stopped {{paused}} of {{total}} tasks; {{failed}} failed", { paused, total: results.length, failed }), "error");
      }
    } finally {
      setIsPausingAll(false);
    }
  }, [onPauseTask, pauseEligibleCount, columnLabelText, pauseEligibleTasks, addToast, confirm, t]);

  const handleMoveAllToTodo = useCallback(async () => {
    setIsMenuOpen(false);
    if (tasks.length === 0) return;

    const confirmed = await confirm({
      title: t("column.moveAllToTodoTitle", "Move All to Todo"),
      message: t("column.moveAllToTodoMessage", "Move all {{count}} {{columnLabel}} task{{plural}} to Todo?", { count: tasks.length, columnLabel: columnLabelText.toLowerCase(), plural: tasks.length === 1 ? "" : "s" }),
    });
    if (!confirmed) return;

    const hasAnyProgress = tasks.some((task) => task.steps.some((step) => step.status !== "pending"));
    let preserveProgress = false;
    if (hasAnyProgress) {
      const keepProgress = await confirm({
        title: t("column.preserveProgressTitle", "Preserve Progress?"),
        message: t("column.preserveProgressMoveTodoMessage", "Some tasks have completed steps. Keep progress before moving to Todo?"),
        confirmLabel: t("column.keepProgress", "Keep Progress"),
        cancelLabel: t("column.resetProgress", "Reset Progress"),
      });

      if (keepProgress) {
        preserveProgress = true;
      } else {
        const resetProgress = await confirm({
          title: t("column.resetProgressTitle", "Reset Progress?"),
          message: t("column.resetProgressMoveTodoMessage", "Reset step progress for tasks before moving to Todo?"),
          confirmLabel: t("column.resetProgressConfirm", "Reset Progress"),
          cancelLabel: t("column.cancelMove", "Cancel Move"),
          danger: true,
        });
        if (!resetProgress) {
          return;
        }
      }
    }

    setIsMovingAllToTodo(true);
    try {
      const results = await Promise.allSettled(
        tasks.map((task) => onMoveTask(task.id, "todo", preserveProgress ? { preserveProgress: true } : undefined)),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const moved = results.length - failed;
      if (failed === 0) {
        addToast(t("column.movedToTodo", "Moved {{count}} task{{plural}} to Todo", { count: moved, plural: moved === 1 ? "" : "s" }), "success");
      } else {
        addToast(t("column.moveToTodoPartialFailure", "Moved {{moved}} of {{total}} tasks to Todo; {{failed}} failed", { moved, total: results.length, failed }), "error");
      }
    } finally {
      setIsMovingAllToTodo(false);
    }
  }, [tasks, columnLabelText, onMoveTask, addToast, confirm, t]);

  /*
  FNXC:DoneColumnSorting 2026-06-29-20:23:
  In workflow mode, the Done-sort control belongs to non-archived complete lanes even when the workflow uses a custom column id such as `shipped`; legacy mode remains limited to the literal Done column.
  */
  const isDoneSortColumn = workflowMode ? columnFlags?.complete === true && columnFlags?.archived !== true : column === "done";
  const showDoneSortControl = isDoneSortColumn && doneSortMode !== undefined && !!onDoneSortModeChange;
  const showDoneArchiveAction = isDoneSortColumn && !!onArchiveAllDone;
  /*
  FNXC:PlanApproval 2026-07-01-08:44:
  Triage and workflow intake/planning column actions need a Board shortcut that mirrors the project auto-approve plan override without replacing Settings modal's full workflow/auto-approve/require-all editor.

  FNXC:PlanApproval 2026-07-07-00:00 (FN-7653 correction):
  This shortcut belongs ONLY to the intake/planning column, never to hold (Todo-like) columns — the built-in Coding workflow's Todo column carries the hold trait and was wrongly surfacing this toggle. Board.tsx is the single source of truth gating which columns receive `onTogglePlanAutoApprove`; Column.tsx just renders whatever prop it is given, so the fix lives in Board.tsx's intake-only gate, not here.
  */
  const hasPlanAutoApproveAction = !!onTogglePlanAutoApprove;
  const hasDoneMenuActions = showDoneSortControl || showDoneArchiveAction;
  const hasColumnMenu = hasColumnBulkActions || hasDoneMenuActions || hasPlanAutoApproveAction;
  const doneSortControlLabel = t("column.doneSortControlLabel", "Sort Done tasks");
  const doneSortOptions: Array<{ mode: DoneColumnSortMode; label: string }> = [
    { mode: "completion-date-desc", label: t("column.doneSortCompletionDateDesc", "Completion date (newest first)") },
    { mode: "task-id-desc", label: t("column.doneSortTaskIdDesc", "Task ID (newest first)") },
  ];

  const handleDoneSortModeSelect = useCallback((mode: DoneColumnSortMode) => {
    onDoneSortModeChange?.(mode);
    setIsMenuOpen(false);
  }, [onDoneSortModeChange]);

  const handlePlanAutoApproveToggle = useCallback(() => {
    onTogglePlanAutoApprove?.();
    setIsMenuOpen(false);
  }, [onTogglePlanAutoApprove]);

  const handleArchiveAll = useCallback(async () => {
    setIsMenuOpen(false);
    if (!onArchiveAllDone) return;
    if (tasks.length === 0) return;

    const confirmed = await confirm({
      title: t("column.archiveAllTitle", "Archive All Done"),
      message: t("column.archiveAllMessage", "Archive all {{count}} done tasks?", { count: tasks.length }),
      danger: true,
    });
    if (!confirmed) return;

    try {
      const archived = await onArchiveAllDone();
      addToast(t("column.archivedTasks", "Archived {{count}} tasks", { count: archived.length }), "success");
    } catch (err) {
      addToast(getErrorMessage(err) || t("column.failedToArchive", "Failed to archive tasks"), "error");
    }
  }, [onArchiveAllDone, tasks.length, addToast, confirm, t]);

  return (
    <div
      className={`column${dragOver ? " drag-over" : ""}${isArchived ? " column-archived" : ""}${isCollapsed ? " column-collapsed" : ""}`}
      data-column={column}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="column-header">
        <div className={`column-dot dot-${column}`} />
        <h2>{workflowMode ? (columnDisplayName ?? COLUMN_LABELS[column] ?? column) : COLUMN_LABELS[column]}</h2>
        <span
          className={`column-count${countFlashing ? " count-flash" : ""}`}
          aria-label={t("column.executingOfTotal", "{{active}} executing of {{total}}", { active: activeTaskCount, total: tasks.length })}
        >
          <span>{activeTaskCount}</span>/<span>{tasks.length}</span>
        </span>
        {(workflowMode ? isReviewColumn : column === "in-review") && onToggleAutoMerge && (
          <label className="auto-merge-toggle" title={autoMerge ? t("column.autoMergeEnabled", "Auto-merge enabled") : t("column.autoMergeDisabled", "Auto-merge disabled")}>
            {/*
            FNXC:AutoMergeA11y 2026-07-14-19:20:
            Explicit aria-label keeps the control discoverable as "Auto-merge" for assistive tech and mobile regression tests even when the visible toggle-label is hidden by CSS or i18n wrappers.
            */}
            <input
              type="checkbox"
              checked={!!autoMerge}
              onChange={onToggleAutoMerge}
              aria-label={t("column.autoMerge", "Auto-merge")}
            />
            <span className="toggle-slider" />
            <span className="toggle-label">{t("column.autoMerge", "Auto-merge")}</span>
          </label>
        )}
        {onNewTask && (
          <button className="btn btn-task-create btn-sm" onClick={onNewTask}>
            + {t("column.newTask", "New Task")}
          </button>
        )}

        {isArchived && onToggleCollapse && (
          <button
            className="btn btn-icon btn-sm"
            onClick={onToggleCollapse}
            title={collapsed ? t("column.expandArchivedTitle", "Expand archived tasks") : t("column.collapseArchivedTitle", "Collapse archived tasks")}
            aria-label={collapsed ? t("column.expandArchivedLabel", "Expand archived tasks") : t("column.collapseArchivedLabel", "Collapse archived tasks")}
          >
            {/* Directional chevrons stay explicit for clearer collapsed-state affordance in compact headers. */}
            {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        )}
        {hasColumnMenu && (
          <div className="column-menu" ref={menuRef}>
            {/**
            FNXC:DoneColumnActions 2026-06-30-00:00:
            Done and workflow complete-column archive/sort affordances must share this column actions dropdown with existing bulk actions, preventing duplicate header controls on desktop and mobile while preserving the original sort modes and archive confirmation path.
            */}
            <button
              type="button"
              className="btn btn-icon btn-sm"
              onClick={() => setIsMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              aria-label={t("column.actionsAriaLabel", "{{columnLabel}} column actions", { columnLabel: columnLabelText })}
              title={t("column.actionsTitle", "Column actions")}
              disabled={isMenuBusy}
            >
              <MoreVertical />
            </button>
            {isMenuOpen && (
              <div className="column-menu-popover" role="menu">
                {hasPlanAutoApproveAction && (
                  <label className="column-menu-item auto-merge-toggle" role="menuitemcheckbox" aria-checked={!!planAutoApproveEnabled}>
                    <span className="column-menu-item-row">
                      <input
                        type="checkbox"
                        checked={!!planAutoApproveEnabled}
                        onChange={handlePlanAutoApproveToggle}
                        aria-label={t("column.planAutoApproveLabel", "Auto-approve plan")}
                      />
                      <span className="toggle-slider" aria-hidden="true" />
                      <span>{t("column.planAutoApproveLabel", "Auto-approve plan")}</span>
                    </span>
                    <span className="column-menu-item-hint">
                      {planAutoApproveEnabled
                        ? t("column.planAutoApproveOnHint", "On bypasses manual plan approval for this project")
                        : t("column.planAutoApproveOffHint", "Off uses the workflow/default plan approval setting")}
                    </span>
                  </label>
                )}
                {showDoneSortControl && (
                  <div className="column-menu-group" role="group" aria-label={doneSortControlLabel}>
                    {doneSortOptions.map((option) => (
                      <button
                        key={option.mode}
                        type="button"
                        role="menuitemradio"
                        aria-checked={doneSortMode === option.mode}
                        className="column-menu-item column-menu-item-radio"
                        onClick={() => handleDoneSortModeSelect(option.mode)}
                      >
                        <span className="column-menu-item-row">
                          <span className="column-menu-item-check" aria-hidden="true">{doneSortMode === option.mode ? "✓" : ""}</span>
                          <span>{option.label}</span>
                        </span>
                        <span className="column-menu-item-hint">
                          {option.mode === "completion-date-desc"
                            ? t("column.doneSortCompletionDateDescHint", "Show recently completed tasks first")
                            : t("column.doneSortTaskIdDescHint", "Show highest task IDs first")}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {showDoneArchiveAction && (
                  <button
                    type="button"
                    role="menuitem"
                    className="column-menu-item"
                    onClick={() => void handleArchiveAll()}
                    disabled={tasks.length === 0}
                  >
                    {t("column.archiveAllDoneTitle", "Archive all done tasks")}
                    <span className="column-menu-item-hint">
                      {tasks.length === 0
                        ? t("column.noDoneTasksToArchive", "No done tasks to archive")
                        : t("column.archiveAllDoneHint", "Archive {{count}} done task{{plural}}", { count: tasks.length, plural: tasks.length === 1 ? "" : "s" })}
                    </span>
                  </button>
                )}
                {isTodoLikeColumn && (
                  <button
                    type="button"
                    role="menuitem"
                    className="column-menu-item"
                    onClick={() => void handleReplanAll()}
                    disabled={tasks.length === 0 || isReplanning}
                  >
                    {t("column.replanAll", "Replan All")}
                    <span className="column-menu-item-hint">
                      {t("column.replanAllHint", "Move {{count}} task{{plural}} to Planning", { count: tasks.length, plural: tasks.length === 1 ? "" : "s" })}
                    </span>
                  </button>
                )}
                {(isProcessingColumn || isReviewColumn) && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="column-menu-item"
                      onClick={() => void handlePauseAll()}
                      disabled={pauseEligibleCount === 0 || isPausingAll || !onPauseTask}
                    >
                      {t("column.stopAll", "Stop All")}
                      <span className="column-menu-item-hint">
                        {tasks.length === 0
                          ? t("column.noTasksInColumn", "No tasks in this column")
                          : pauseEligibleCount === 0
                            ? t("column.noManuallyPausableTasks", "No manually pausable tasks")
                            : t("column.pauseHint", "Pause {{count}} active unassigned task{{plural}}", { count: pauseEligibleCount, plural: pauseEligibleCount === 1 ? "" : "s" })}
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="column-menu-item"
                      onClick={() => void handleMoveAllToTodo()}
                      disabled={tasks.length === 0 || isMovingAllToTodo}
                    >
                      {t("column.moveAllToTodo", "Move All to Todo")}
                      <span className="column-menu-item-hint">
                        {t("column.moveToTodoHint", "Move {{count}} task{{plural}} to Todo", { count: tasks.length, plural: tasks.length === 1 ? "" : "s" })}
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {!isCollapsed && COLUMN_DESCRIPTIONS[column] !== undefined && (
        <p className="column-desc">{COLUMN_DESCRIPTIONS[column]}</p>
      )}
      {!isCollapsed && inlineFeedback && (
        <p className="column-inline-feedback" role="status" data-testid="column-inline-feedback">
          {inlineFeedback}
        </p>
      )}
      {!isCollapsed && (
        <div className="column-body">
          {canCreateInColumn && (
            <QuickEntryBox 
              onCreate={handleQuickCreate}
              addToast={addToast} 
              tasks={allTasks ?? []}
              availableModels={availableModels}
              onPlanningMode={onPlanningMode}
              onSubtaskBreakdown={onSubtaskBreakdown}
              workflowId={workflowMode ? workflowId : undefined}
              workflowOptions={workflowMode ? workflowOptions : undefined}
              defaultWorkflowId={workflowMode ? defaultWorkflowId : undefined}
              projectId={projectId}
              autoExpand={false}
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
                  key={group.label}
                  label={group.label}
                  activeTasks={group.activeTasks}
                  queuedTasks={group.queuedTasks}
                  projectId={projectId}
                  onOpenDetail={onOpenDetail}
                  onOpenRefine={onOpenRefine}
                  onPlanningMode={onPlanningMode}
                  workflowId={workflowMode ? workflowId : undefined}
                  onMoveTask={onMoveTask}
                  addToast={addToast}
                  globalPaused={globalPaused}
                  onUpdateTask={onUpdateTask}
                  onPauseTask={onPauseTask}
                  onRetryTask={onRetryTask}
                  onUnpauseTask={onUnpauseTask}
                  onResetTask={onResetTask}
                  onDuplicateTask={onDuplicateTask}
                  onMergeTask={onMergeTask}
                  onArchiveTask={onArchiveTask}
                  onUnarchiveTask={onUnarchiveTask}
                  onRevertTask={onRevertTask}
                  onDeleteTask={onDeleteTask}
                  onOpenDetailWithTab={onOpenDetailWithTab}
                  taskStuckTimeoutMs={taskStuckTimeoutMs}
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
            <>
              {visibleTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  projectId={projectId}
                  onOpenDetail={onOpenDetail}
                  onPlanningMode={onPlanningMode}
                  planningWorkflowId={workflowMode ? workflowId : taskWorkflowBadges?.get(task.id)?.workflowId ?? null}
                  onOpenRefine={onOpenRefine}
                  onOpenGroupModal={onOpenGroupModal}
                  addToast={addToast}
                  globalPaused={globalPaused}
                  onUpdateTask={onUpdateTask}
                  onPauseTask={onPauseTask}
                  onRetryTask={onRetryTask}
                  onUnpauseTask={onUnpauseTask}
                  onResetTask={onResetTask}
                  onDuplicateTask={onDuplicateTask}
                  onMergeTask={onMergeTask}
                  onArchiveTask={onArchiveTask}
                  onUnarchiveTask={onUnarchiveTask}
                  onRevertTask={onRevertTask}
                  onDeleteTask={onDeleteTask}
                  onOpenDetailWithTab={onOpenDetailWithTab}
                  taskStuckTimeoutMs={taskStuckTimeoutMs}
                  onOpenMission={onOpenMission}
                  onMoveTask={onMoveTask}
                  taskColumnFlags={getTaskColumnFlags(task)}
                  taskMoveColumns={getTaskContextMenuColumns(task)}
                  onPromote={isHoldColumn && onPromote ? handlePromote : undefined}
                  isPromoting={isHoldColumn && onPromote ? promotingIds.has(task.id) : undefined}
                  lastFetchTimeMs={lastFetchTimeMs}
                  cardFieldDefs={taskCardFieldDefs?.get(task.id)}
                  workflowBadge={taskWorkflowBadges?.get(task.id)}
                  fanout={blockerFanoutMap?.get(task.id)}
                  prAuthAvailable={prAuthAvailable}
                  autoMergeEnabled={Boolean(autoMerge)}
                  mergeStrategy={mergeStrategy}
                  nearDuplicateCanonicalInactive={resolveNearDuplicateCanonicalInactive(task)}
                />
              ))}
              {shouldPaginate && hiddenTaskCount > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleLoadMore}
                >
                  {t("column.loadMore", "Load {{count}} more ({{remaining}} remaining)", { count: Math.min(VISIBLE_TASKS_INCREMENT, hiddenTaskCount), remaining: hiddenTaskCount })}
                </button>
              )}
              {/*
              FNXC:ArchivePagination 2026-07-08-00:00:
              FN-7659 — the Archived column's "Show more" only renders when the
              server reports another page beyond what's currently loaded
              (archivedHasMore), so an empty archive or an archive smaller than
              one page never shows the button (no empty shell on desktop or
              mobile). Distinct from the shouldPaginate/handleLoadMore button
              above, which reveals more of an already-fetched client array for
              non-archived columns.
              */}
              {isArchived && archivedHasMore && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleLoadMoreArchived}
                  disabled={archivedLoadingMore || isLoadingMoreArchived}
                >
                  {(archivedLoadingMore || isLoadingMoreArchived)
                    ? t("column.loadMoreArchivedLoading", "Loading\u2026")
                    : t("column.loadMoreArchived", "Show more")}
                </button>
              )}
            </>
          )}
          <PluginSlot slotId="board-column-footer" projectId={projectId} />
        </div>
      )}
    </div>
  );
}

export const Column = memo(ColumnComponent);
Column.displayName = "Column";
