import "./TaskContextMenu.css";
import type { KeyboardEvent, ReactNode } from "react";
import { Fragment, useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import type { ColumnId, Task, TaskDetail } from "@fusion/core";
import { COLUMNS, VALID_TRANSITIONS, isColumn } from "@fusion/core";

export type TaskMenuActionTone = "default" | "danger" | "note";

export interface TaskMenuActionDescriptor {
  id: string;
  label: string;
  tone?: TaskMenuActionTone;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface TaskMoveActionDescriptor {
  column: ColumnId;
  label: string;
  primaryLabel: string;
}

export interface TaskContextMenuColumnFlags {
  complete?: boolean;
  archived?: boolean;
  hiddenFromBoard?: boolean;
  hold?: boolean;
  intake?: boolean;
  mergeBlocker?: boolean;
  humanReview?: boolean;
}

export interface TaskContextMenuColumnMetadata {
  id: ColumnId;
  label: string;
  flags?: TaskContextMenuColumnFlags;
}

export interface TaskReviewActionDescriptor {
  id: "merge" | "start-pr-review" | "check-pr-status" | "pr-automation";
  label: string;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface TaskActionMenuModel {
  actions: TaskMenuActionDescriptor[];
  moveTransitions: TaskMoveActionDescriptor[];
  reviewAction?: TaskReviewActionDescriptor;
  shouldShowActionsMenu: boolean;
  isTaskPaused: boolean;
}

export interface BuildTaskActionMenuModelOptions {
  task: Task | TaskDetail;
  t: TFunction<"app">;
  columnLabel: (column: ColumnId) => string;
  currentColumnFlags?: TaskContextMenuColumnFlags;
  workflowMoveColumns?: readonly TaskContextMenuColumnMetadata[];
  canRetryTask?: boolean;
  hasDuplicateHandler?: boolean;
  hasRetryHandler?: boolean;
  hasResetHandler?: boolean;
  hasAssignedAgent?: boolean;
  mergeStrategy?: string;
  autoMergeEnabled?: boolean;
  prAutomationLabel?: string;
  isCheckingPrStatus?: boolean;
  onDelete?: () => void;
  onDuplicate?: () => void;
  onOpenRefine?: () => void;
  onRespecify?: () => void;
  onRetry?: () => void;
  onReset?: () => void;
  onTogglePause?: () => void;
  onMerge?: () => void;
  onStartPrReview?: () => void;
  onCheckPrStatus?: () => void;
}

export function getTaskPrAutomationLabel(t: TFunction<"app">, status?: string): string | undefined {
  if (!status) return undefined;
  const prAutomationStatusLabels: Record<string, string> = {
    "creating-pr": t("taskDetail.pr.creatingPr", "Creating PR…"),
    "awaiting-pr-checks": t("taskDetail.pr.awaitingChecks", "Awaiting PR checks"),
    "merging-pr": t("taskDetail.pr.mergingPr", "Merging PR…"),
    "merging-fix": t("taskDetail.pr.mergingFixes", "Merging fixes…"),
  };
  return prAutomationStatusLabels[status];
}

function isReviewColumn(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  return column === "in-review" || flags?.mergeBlocker === true || flags?.humanReview === true;
}

function isDoneOrReview(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  return column === "done" || isReviewColumn(column, flags) || (flags?.complete === true && flags?.archived !== true);
}

function isMutableLiveColumn(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  if (flags) return flags.complete !== true && flags.archived !== true;
  return column !== "done" && column !== "archived";
}

function isDefaultWorkflowColumnSet(columns: readonly TaskContextMenuColumnMetadata[]): boolean {
  if (columns.length !== COLUMNS.length) return false;
  const ids = new Set(columns.map((column) => column.id));
  return COLUMNS.every((column) => ids.has(column));
}

/*
FNXC:TaskContextMenu 2026-06-30-12:42:
Workflow-column Board/List menus derive move targets from the task's workflow metadata instead of legacy VALID_TRANSITIONS. Built-in/default workflows keep exact legacy parity; custom workflows use visible neighbor columns and trait flags so custom complete/archived lanes are not treated as mutable live work.

FNXC:TaskContextMenu 2026-06-30-13:02:
Manual pull-request review has two separate operator intents: Start PR Review opens PR creation, while Merge & Close calls the merge endpoint. Keep distinct callbacks so card/list context menus cannot merge a task when the user asked to create a PR.
*/
function getWorkflowMoveTargets(task: Task | TaskDetail, columns: readonly TaskContextMenuColumnMetadata[]): ColumnId[] {
  const visibleColumns = columns.filter((column) => column.flags?.hiddenFromBoard !== true);
  if (isDefaultWorkflowColumnSet(visibleColumns) && isColumn(task.column)) {
    return task.column === "in-review" ? ["todo", "in-progress"] : [...VALID_TRANSITIONS[task.column]];
  }

  const currentIndex = visibleColumns.findIndex((column) => column.id === task.column);
  if (currentIndex < 0) return [];
  const targets: ColumnId[] = [];
  const previous = visibleColumns[currentIndex - 1]?.id;
  const next = visibleColumns[currentIndex + 1]?.id;
  if (previous) targets.push(previous);
  if (next) targets.push(next);
  return targets;
}

export function getTaskMoveTransitions(
  task: Task | TaskDetail,
  t: TFunction<"app">,
  columnLabel: (column: ColumnId) => string,
  workflowMoveColumns?: readonly TaskContextMenuColumnMetadata[],
): TaskMoveActionDescriptor[] {
  const moveTransitions: ColumnId[] = workflowMoveColumns
    ? getWorkflowMoveTargets(task, workflowMoveColumns)
    : isColumn(task.column)
      ? (task.column === "in-review" ? ["todo", "in-progress"] : [...VALID_TRANSITIONS[task.column]])
      : [];
  const workflowLabelById = new Map((workflowMoveColumns ?? []).map((column) => [column.id, column.label]));

  return moveTransitions.map((column) => {
    const label = workflowLabelById.get(column) ?? columnLabel(column);
    return {
      column,
      label: column === "in-progress" && task.column === "in-review"
        ? t("taskDetail.move.backToInProgress", "Back to In Progress")
        : t("taskDetail.move.moveTo", "Move to {{column}}", { column: label }),
      primaryLabel: t("taskDetail.move.moveTo", "Move to {{column}}", { column: label }),
    };
  });
}

export function getTaskReviewAction(
  task: Task | TaskDetail,
  options: Pick<BuildTaskActionMenuModelOptions, "t" | "currentColumnFlags" | "mergeStrategy" | "autoMergeEnabled" | "prAutomationLabel" | "isCheckingPrStatus" | "onMerge" | "onStartPrReview" | "onCheckPrStatus">,
): TaskReviewActionDescriptor | undefined {
  const currentColumnFlags = options.currentColumnFlags;
  if (!isReviewColumn(task.column, currentColumnFlags)) {
    return undefined;
  }

  if (options.prAutomationLabel) {
    return { id: "pr-automation", label: options.prAutomationLabel, disabled: true };
  }

  const isManualPrFlow = options.mergeStrategy === "pull-request" && !options.autoMergeEnabled;
  const prStatus = task.prInfo?.status;

  if (isManualPrFlow) {
    if (!task.prInfo) {
      return { id: "start-pr-review", label: options.t("taskDetail.pr.startPrReview", "Start PR Review"), onSelect: options.onStartPrReview };
    }
    if (prStatus === "open") {
      return {
        id: "check-pr-status",
        label: options.t("taskDetail.pr.checkPrStatus", "Check PR Status"),
        disabled: options.isCheckingPrStatus,
        onSelect: options.onCheckPrStatus,
      };
    }
    if (prStatus === "merged") {
      return { id: "merge", label: options.t("taskDetail.pr.finishAndClose", "Finish & Close"), onSelect: options.onMerge };
    }
  }

  return { id: "merge", label: options.t("taskDetail.pr.mergeAndClose", "Merge & Close"), onSelect: options.onMerge };
}

export function buildTaskActionMenuModel(options: BuildTaskActionMenuModelOptions): TaskActionMenuModel {
  const {
    task,
    t,
    columnLabel,
    currentColumnFlags,
    workflowMoveColumns,
    canRetryTask = false,
    hasDuplicateHandler = Boolean(options.onDuplicate),
    hasRetryHandler = Boolean(options.onRetry),
    hasResetHandler = Boolean(options.onReset),
    hasAssignedAgent = Boolean(task.assignedAgentId),
  } = options;
  const isTaskPaused = Boolean(task.paused || task.userPaused);
  const actions: TaskMenuActionDescriptor[] = [
    {
      id: "delete",
      label: t("taskDetail.delete.btn", "Delete"),
      tone: "danger",
      onSelect: options.onDelete,
    },
  ];

  if (hasDuplicateHandler) {
    actions.push({ id: "duplicate", label: t("taskDetail.duplicate.btn", "Duplicate"), onSelect: options.onDuplicate });
  }

  if (isDoneOrReview(task.column, currentColumnFlags) && options.onOpenRefine) {
    actions.push({ id: "refine", label: t("taskDetail.refine.btn", "Refine"), onSelect: options.onOpenRefine });
  }

  actions.push({ id: "respecify", label: t("taskDetail.respecify.btn", "Respecify"), onSelect: options.onRespecify });

  if (canRetryTask && hasRetryHandler) {
    actions.push({ id: "retry", label: t("taskDetail.retry.btn", "Retry"), onSelect: options.onRetry });
  }

  if (hasResetHandler && isMutableLiveColumn(task.column, currentColumnFlags)) {
    actions.push({ id: "reset", label: t("taskDetail.reset.btn", "Reset"), tone: "danger", onSelect: options.onReset });
  }

  if (isMutableLiveColumn(task.column, currentColumnFlags)) {
    actions.push({
      id: isTaskPaused ? "unpause" : "pause",
      label: isTaskPaused ? t("taskDetail.pause.unpauseBtn", "Unpause") : t("taskDetail.pause.pauseBtn", "Pause"),
      onSelect: options.onTogglePause,
    });
  }

  if (isMutableLiveColumn(task.column, currentColumnFlags) && task.paused && task.pausedByAgentId) {
    actions.push({ id: "paused-by-agent", label: t("taskDetail.pause.pausedByAgent", "Paused by agent"), tone: "note", disabled: true });
  }

  return {
    actions,
    moveTransitions: getTaskMoveTransitions(task, t, columnLabel, workflowMoveColumns),
    reviewAction: getTaskReviewAction(task, options),
    shouldShowActionsMenu:
      task.column !== "triage" ||
      task.status === "awaiting-approval" ||
      canRetryTask ||
      isTaskPaused ||
      hasAssignedAgent,
    isTaskPaused,
  };
}

export interface TaskContextMenuProps {
  actions: TaskMenuActionDescriptor[];
  role?: "menu" | "list";
  className?: string;
  itemClassName?: string;
  dangerItemClassName?: string;
  noteItemClassName?: string;
  onActionSelect?: (action: TaskMenuActionDescriptor) => void;
  renderAction?: (action: TaskMenuActionDescriptor, defaultNode: ReactNode) => ReactNode;
  autoFocusFirstItem?: boolean;
}

/*
FNXC:TaskContextMenu 2026-06-29-00:00:
Card, list, and detail task menus must share one action descriptor model so labels and lifecycle availability do not drift between surfaces. Keep destructive handlers injected by the host so existing confirmations, toasts, and API calls remain the source of truth.
*/
export function TaskContextMenu({
  actions,
  role = "menu",
  className = "task-context-menu",
  itemClassName = "task-context-menu__item",
  dangerItemClassName = "task-context-menu__item--danger",
  noteItemClassName = "task-context-menu__item--note",
  onActionSelect,
  renderAction,
  autoFocusFirstItem = true,
}: TaskContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autoFocusFirstItem) return;
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    firstItem?.focus();
  }, [actions, autoFocusFirstItem]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (items.length === 0) return;
    event.preventDefault();
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const lastIndex = items.length - 1;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? lastIndex
        : event.key === "ArrowUp"
          ? (activeIndex <= 0 ? lastIndex : activeIndex - 1)
          : (activeIndex >= lastIndex ? 0 : activeIndex + 1);
    items[nextIndex]?.focus();
  };

  return (
    <div ref={menuRef} className={className} role={role} onKeyDown={handleKeyDown}>
      {actions.map((action) => {
        const classes = [itemClassName];
        if (action.tone === "danger") classes.push(dangerItemClassName);
        if (action.tone === "note") classes.push(noteItemClassName);

        const defaultNode = action.tone === "note" ? (
          <span key={action.id} className={classes.join(" ")} role="note">
            {action.label}
          </span>
        ) : (
          <button
            key={action.id}
            type="button"
            className={classes.join(" ")}
            role={role === "menu" ? "menuitem" : undefined}
            disabled={action.disabled}
            onClick={() => {
              onActionSelect?.(action);
              action.onSelect?.();
            }}
          >
            {action.label}
          </button>
        );

        return <Fragment key={action.id}>{renderAction ? renderAction(action, defaultNode) : defaultNode}</Fragment>;
      })}
    </div>
  );
}
