import { memo, useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useAutoPaginationSentinel } from "../hooks/useAutoPaginationSentinel";
import { useVirtualizedList } from "../hooks/useVirtualizedList";
import { useTranslation } from "react-i18next";
import { useFlashOnIncrease } from "../hooks/useFlashOnIncrease";
import { useConfirm } from "../hooks/useConfirm";
import { rebuildTaskSpec } from "../api";
import { COLUMN_LABELS, COLUMN_DESCRIPTIONS, type TaskColumnSortMode, type DoneColumnSortMode, type Task, type TaskDetail, type Column as ColumnType, type ColumnId, type TaskCreateInput, type GithubIssueAction, type MergeResult } from "@fusion/core";
import { enrichRunningAgentTaskShapeFromFlags, isRunningAgentTask } from "../../../core/src/agents/live-agent-count";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/duplicates/near-duplicate-canonical";
import { TaskCard } from "./TaskCard";
import { WorktreeGroup } from "./WorktreeGroup";
import { QuickEntryBox } from "./QuickEntryBox";
import { PluginSlot } from "./PluginSlot";
import { groupByWorktree } from "../utils/worktreeGrouping";
import {
  isPreImplementationColumnRole,
  isReviewColumnRole,
  isWipColumnRole,
} from "../utils/columnRoles";
import type { ToastType } from "../hooks/useToast";
import type { TaskContextMenuColumnMetadata } from "./TaskContextMenu";
import { MoreVertical } from "lucide-react";
import type { BoardWorkflowDefinition, ModelInfo, BoardWorkflowColumnFlags, RevertTaskOptions, RevertTaskResult } from "../api";
import type { BlockerFanoutEntry } from "../hooks/useBlockerFanout";

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
  onPauseTask?: (id: string) => Promise<Task>;
  onUnpauseTask?: (id: string) => Promise<Task>;
  onResetTask?: (id: string, options?: { description?: string }) => Promise<Task>;
  onDuplicateTask?: (id: string, options?: { workflowId?: string }) => Promise<Task>;
  onMergeTask?: (id: string) => Promise<MergeResult>;
  onOpenDetail: (task: Task | TaskDetail) => void;
  onOpenRefine?: (task: Task | TaskDetail) => void;
  onOpenGroupModal?: (groupId: string) => void;
  addToast: (message: string, type?: ToastType) => void;
  onQuickCreate?: (input: TaskCreateInput) => Promise<Task | void>;
  onNewTask?: (workflowId?: string | null) => void;
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
  onOpenChatWithPrefill?: (prefillText: string) => void;
  onRevertTask?: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
  /*
  FNXC:TaskRevert 2026-08-27-02:18:
  Reverted work is identified by a card label in its own column rather than a separate column,
  so its Delete and Revise resolution actions must reach the in-column card.
  */
  onReviseTask?: (task: Task) => void;
  onDeleteTask?: (id: string, options?: {
    removeDependencyReferences?: boolean;
    removeLineageReferences?: boolean;
    githubIssueAction?: GithubIssueAction;
  }) => Promise<Task>;
  /** Current display order for this Board lane. */
  sortMode?: TaskColumnSortMode;
  /** Updates this lane's Board-local display order. */
  onSortModeChange?: (mode: TaskColumnSortMode) => void;
  /** Compatibility aliases retained for existing Done-column integrations. */
  doneSortMode?: DoneColumnSortMode;
  onDoneSortModeChange?: (mode: DoneColumnSortMode) => void;
  /** Exact server count for a paged lane; defaults to the loaded task count. */
  totalTaskCount?: number;
  serverHasMore?: boolean;
  serverLoadingMore?: boolean;
  onLoadMoreServer?: () => Promise<void>;
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
}

function ColumnComponent({ column, tasks, projectId, maxWorktrees, showWorktreeGrouping, onMoveTask, onPauseTask, onUnpauseTask, onResetTask, onDuplicateTask, onMergeTask, onOpenDetail, onOpenRefine, onOpenGroupModal, addToast, onQuickCreate, onNewTask, autoMerge, mergeStrategy = "direct", onToggleAutoMerge, planAutoApproveEnabled, onTogglePlanAutoApprove, globalPaused, onUpdateTask, onRetryTask, onOpenChatWithPrefill, onRevertTask, onReviseTask, onDeleteTask, sortMode, onSortModeChange, doneSortMode, onDoneSortModeChange, totalTaskCount, serverHasMore, serverLoadingMore, onLoadMoreServer, allTasks, availableModels, onPlanningMode, onOpenDetailWithTab, favoriteProviders, favoriteModels, onToggleFavorite, onToggleModelFavorite, isSearchActive, onOpenMission, lastFetchTimeMs, taskCardFieldDefs, taskWorkflowBadges, blockerFanoutMap, prAuthAvailable, holdTaskIds, workflowMode, workflowId, workflowOptions, defaultWorkflowId, columnDisplayName, columnDescription, columnFlags, workflowContextMenuColumns, taskContextMenuColumnsByTaskId }: ColumnProps) {
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
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isReplanning, setIsReplanning] = useState(false);
  const [isPausingAll, setIsPausingAll] = useState(false);
  /*
  FNXC:WorkflowColumnDescriptions 2026-07-22-12:30:
  Whitespace-only values can exist in pre-editor/custom IR. Treat them as
  absent so they retain lifecycle fallback rather than creating a blank shell.
  */
  const resolvedColumnDescription = columnDescription?.trim() ? columnDescription : COLUMN_DESCRIPTIONS[column];
  const menuRef = useRef<HTMLDivElement | null>(null);
  const isCompleteColumn = columnFlags?.complete === true || (!workflowMode && column === "done");
  const displayedTaskCount = totalTaskCount ?? tasks.length;
  const countFlashing = useFlashOnIncrease(displayedTaskCount);
  const { confirm } = useConfirm();
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
  FNXC:BoardColumnCount 2026-07-21-19:30:
  Column header is executing/total (e.g. 3/4). Executing uses the same Running predicate as the
  footer (unpaused WIP, live planners, active review). Total is the card count in this lane.

  FNXC:BoardColumnCount 2026-08-01-17:53:
  Operator requirement: summing the lane headers must never exceed the engine's live-agent
  population (the concurrency cap's admission truth). The former union with the card
  activity-chrome predicate (FN-8494 REVISING chrome et al.) let the sum read cap+1 (e.g. 10
  glowing cards under a 9-slot limit), which operators read as a capacity breach. The union is
  removed and the chrome predicate itself (isTaskAgentActive) now delegates its positive arm to
  the same shared Running predicate, so the header still agrees with the glowing cards below it:
  glow is a strict subset of Running, never a superset.
  */
  const activeTaskCount = useMemo(
    () => tasks.filter((task) =>
      // FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (PR #2566 review — greptile): these
      // tasks are IN this column, so the column's own flags are their column traits. Without
      // them the header undercounts executing work on a merged planning lane.
      isRunningAgentTask(enrichRunningAgentTaskShapeFromFlags(task, columnFlags)),
    ).length,
    [tasks, columnFlags],
  );
  /*
  FNXC:BoardColumnWindowing 2026-09-07-16:03:
  Every ordinary Board lane mounts only its measured viewport window, including search results. The result signature resets geometry when a different search collection arrives; worktree grouping remains exempt because its provider is already bounded by execution capacity.
  */
  const searchResultSignature = useMemo(() => {
    if (!isSearchActive || tasks.length === 0) return "";
    return `${tasks.length}:${tasks[0]?.id ?? ""}:${tasks[tasks.length - 1]?.id ?? ""}`;
  }, [isSearchActive, tasks]);

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
  const virtualList = useVirtualizedList({
    collectionKey: `${projectId ?? "default"}:${column}:${searchResultSignature}`,
    keys: showWorktreeGroups ? [] : tasks.map((task) => task.id),
    scrollRef: columnBodyRef,
    estimateHeight: 320,
    maxRenderedRows: 40,
    initialAlign: "start",
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
    enabled: !showWorktreeGroups,
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
  FNXC:BoardColumnMenu 2026-08-27-12:01:
  FN-198 keeps bulk replanning server-owned: it rebuilds each task specification and never
  chooses a destination column. `onMoveTask` is forwarded below only for manual-intake Start.
  */
  const handleReplanAll = useCallback(async () => {
    setIsMenuOpen(false);
    if (tasks.length === 0) return;

    const confirmed = await confirm({
      title: t("column.replanAllTitle", "Replan All Tasks"),
      message: t("column.replanAllMessage", "Replan {{count}} task{{plural}} from its original description? Its current plan will be discarded.", { count: tasks.length, plural: tasks.length === 1 ? "" : "s" }),
    });
    if (!confirmed) return;

    setIsReplanning(true);
    try {
      const results = await Promise.allSettled(tasks.map((task) => rebuildTaskSpec(task.id, projectId)));
      const failed = results.filter((result) => result.status === "rejected").length;
      const replanned = results.length - failed;
      if (failed === 0) {
        addToast(t("column.replannedTasks", "Replanned {{count}} task{{plural}}", { count: replanned, plural: replanned === 1 ? "" : "s" }), "success");
      } else {
        addToast(t("column.replanPartialFailure", "Replanned {{replanned}} of {{total}} tasks; {{failed}} failed", { replanned, total: results.length, failed }), "error");
      }
    } finally {
      setIsReplanning(false);
    }
  }, [addToast, confirm, projectId, t, tasks]);

  const pauseEligibleTasks = useMemo(
    () => tasks.filter((task) => !task.paused && !task.assignedAgentId),
    [tasks],
  );
  const pauseEligibleCount = pauseEligibleTasks.length;
  // Bulk-action eligibility (R9): workflow mode keys off trait flags instead of
  // the literal column ids. Todo-equivalent = hold/intake (replan affordance);
  // processing = wip/countsTowardWip; review = mergeBlocker/humanReview.
  const isTodoLikeColumn = isPreImplementationColumnRole(columnFlags, column);
  const isProcessingColumn = isWipColumnRole(columnFlags, column);
  const isReviewColumn = isReviewColumnRole(columnFlags, column);
  const hasColumnBulkActions = isTodoLikeColumn || isProcessingColumn || isReviewColumn;
  const isMenuBusy = isReplanning || isPausingAll;
  const columnLabelText = workflowMode ? (columnDisplayName ?? COLUMN_LABELS[column] ?? column) : (COLUMN_LABELS[column] ?? column);

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


  /*
  FNXC:TaskColumnSorting 2026-09-04-10:36:
  Every visible Board lane uses the same actions menu and keeps its own local ordering mode. Server pagination selects newest Done-page membership first; this control orders only the bounded rows already loaded.
  */
  const effectiveSortMode = sortMode ?? doneSortMode;
  const effectiveSortModeChange = onSortModeChange ?? onDoneSortModeChange;
  const showSortControl = effectiveSortMode !== undefined && !!effectiveSortModeChange;
  /*
  FNXC:PlanApproval 2026-07-01-08:44:
  Triage and workflow intake/planning column actions need a Board shortcut that mirrors the project auto-approve plan override without replacing Settings modal's full workflow/auto-approve/require-all editor.

  FNXC:PlanApproval 2026-07-07-00:00 (FN-7653 correction):
  This shortcut belongs ONLY to the intake/planning column, never to hold (Todo-like) columns — the built-in Coding workflow's Todo column carries the hold trait and was wrongly surfacing this toggle. Board.tsx is the single source of truth gating which columns receive `onTogglePlanAutoApprove`; Column.tsx just renders whatever prop it is given, so the fix lives in Board.tsx's intake-only gate, not here.
  */
  const hasPlanAutoApproveAction = !!onTogglePlanAutoApprove;
  const hasColumnMenu = hasColumnBulkActions || showSortControl || hasPlanAutoApproveAction;
  const sortControlLabel = t("column.sortControlLabel", "Sort tasks in this column");
  const sortOptions: Array<{ mode: TaskColumnSortMode; label: string }> = [
    { mode: "completion-date-desc", label: t("column.sortArrivalDesc", "Arrival in this column — Completion date (newest first)") },
    { mode: "task-id-desc", label: t("column.sortTaskIdDesc", "Task ID (newest first) — highest task number first") },
  ];

  const handleSortModeSelect = useCallback((mode: TaskColumnSortMode) => {
    effectiveSortModeChange?.(mode);
    setIsMenuOpen(false);
  }, [effectiveSortModeChange]);

  const handlePlanAutoApproveToggle = useCallback(() => {
    onTogglePlanAutoApprove?.();
    setIsMenuOpen(false);
  }, [onTogglePlanAutoApprove]);


  return (
    <div
      className="column"
      data-column={column}
    >
      <div className="column-header">
        <div className={`column-dot dot-${column}`} />
        <h2>{workflowMode ? (columnDisplayName ?? COLUMN_LABELS[column] ?? column) : (COLUMN_LABELS[column] ?? column)}</h2>
        <span
          className={`column-count${countFlashing ? " count-flash" : ""}`}
          aria-label={isCompleteColumn
            ? t("column.taskCount", "{{total}} tasks", { total: displayedTaskCount.toLocaleString() })
            : t("column.executingOfTotal", "{{active}} executing of {{total}}", { active: activeTaskCount, total: displayedTaskCount })}
        >
          {isCompleteColumn
            ? <span>{displayedTaskCount.toLocaleString()}</span>
            : <><span>{activeTaskCount}</span>/<span>{displayedTaskCount}</span></>}
        </span>
        {isReviewColumn && onToggleAutoMerge && (
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
          <button className="btn btn-task-create btn-sm" onClick={() => onNewTask()}>
            + {t("column.newTask", "New Task")}
          </button>
        )}

        {hasColumnMenu && (
          <div className="column-menu" ref={menuRef}>
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
                {showSortControl && (
                  <div className="column-menu-group" role="group" aria-label={sortControlLabel}>
                    {sortOptions.map((option) => (
                      <button
                        key={option.mode}
                        type="button"
                        role="menuitemradio"
                        aria-checked={effectiveSortMode === option.mode}
                        className="column-menu-item column-menu-item-radio"
                        onClick={() => handleSortModeSelect(option.mode)}
                      >
                        <span className="column-menu-item-row">
                          <span className="column-menu-item-check" aria-hidden="true">{effectiveSortMode === option.mode ? "✓" : ""}</span>
                          <span>{option.label}</span>
                        </span>
                        <span className="column-menu-item-hint">
                          {option.mode === "completion-date-desc"
                            ? t("column.sortArrivalDescHint", "Show the newest arrivals in this column first")
                            : t("column.sortTaskIdDescHint", "Show the highest task IDs first")}
                        </span>
                      </button>
                    ))}
                  </div>
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
                      {t("column.replanAllHint", "Replan {{count}} task{{plural}} from its original description", { count: tasks.length, plural: tasks.length === 1 ? "" : "s" })}
                    </span>
                  </button>
                )}
                {(isProcessingColumn || isReviewColumn) && (
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
                )}
              </div>
            )}
          </div>
        )}
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
                  onOpenRefine={onOpenRefine}
                  onPlanningMode={onPlanningMode}
                  workflowId={workflowMode ? workflowId : undefined}
                  onMoveTask={onMoveTask}
                  addToast={addToast}
                  globalPaused={globalPaused}
                  onUpdateTask={onUpdateTask}
                  onPauseTask={onPauseTask}
                  onRetryTask={onRetryTask}
                  onOpenChatWithPrefill={onOpenChatWithPrefill}
                  onUnpauseTask={onUnpauseTask}
                  onResetTask={onResetTask}
                  onDuplicateTask={onDuplicateTask}
                  onMergeTask={onMergeTask}
                  onRevertTask={onRevertTask}
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
            <>
              {virtualList.topSpacerHeight > 0 ? <div aria-hidden="true" style={{ height: virtualList.topSpacerHeight }} /> : null}
              {visibleTasks.map((task) => (
                <div key={task.id} ref={virtualList.measureRow(task.id)} data-virtual-task-row={task.id}>
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
                  onOpenChatWithPrefill={onOpenChatWithPrefill}
                  onUnpauseTask={onUnpauseTask}
                  onResetTask={onResetTask}
                  onDuplicateTask={onDuplicateTask}
                  onMergeTask={onMergeTask}
                  onRevertTask={onRevertTask}
                  onReviseTask={onReviseTask}
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
              {virtualList.bottomSpacerHeight > 0 ? <div aria-hidden="true" style={{ height: virtualList.bottomSpacerHeight }} /> : null}
              {serverHasMore ? (
                <div ref={autoPagination.sentinelRef} role="status" aria-live="polite" data-testid="column-auto-pagination-sentinel">
                  {serverLoadingMore ? t("column.loadMoreCompletedLoading", "Loading…") : null}
                </div>
              ) : null}
            </>
          )}
          <PluginSlot slotId="board-column-footer" projectId={projectId} />
        </div>
    </div>
  );
}

export const Column = memo(ColumnComponent);
Column.displayName = "Column";
