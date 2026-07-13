import "./TaskContextMenu.css";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Fragment, useCallback, useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import type { ColumnId, Task, TaskDetail, WorkflowStepResult } from "@fusion/core";
import { COLUMNS, VALID_TRANSITIONS, isColumn } from "@fusion/core";

/*
FNXC:ReviewLaneBypass 2026-07-09-00:00:
Dashboard app code only imports TYPES from @fusion/core (Vite aliases
"@fusion/core" straight to packages/core/src/types.ts to avoid bundling the
full core runtime into the client) — see vite.config.ts. So the bypass
affordance's failed-pre-merge-step selection predicate is duplicated here in
miniature rather than imported from packages/core/src/task-merge.ts's
getLatestFailedPreMergeReviewStep. Keep this in lockstep with that function
and self-healing.ts's latestFailedPreMergeStep (FN-7720): most-recent
phase!=="post-merge" result with status==="failed".
*/
function hasFailedPreMergeReviewStep(task: Pick<Task, "workflowStepResults">): boolean {
  return (task.workflowStepResults ?? []).some(
    (result: WorkflowStepResult) => (result.phase || "pre-merge") === "pre-merge" && result.status === "failed",
  );
}

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
  hasBypassReviewHandler?: boolean;
  mergeStrategy?: string;
  autoMergeEnabled?: boolean;
  prAutomationLabel?: string;
  isCheckingPrStatus?: boolean;
  onDelete?: () => void;
  onDuplicate?: () => void;
  /*
  FNXC:TaskContextMenu 2026-07-13-00:00:
  Pre-execution task cards can open the same Planning Mode handoff as inline create, but only hosts that wire a planning route should expose the action so dock/plugin/detail surfaces never render a dead Plan item.
  */
  onPlan?: () => void;
  onOpenRefine?: () => void;
  onRespecify?: () => void;
  onRetry?: () => void;
  onReset?: () => void;
  onTogglePause?: () => void;
  onMerge?: () => void;
  onStartPrReview?: () => void;
  onCheckPrStatus?: () => void;
  onEnableGithubTracking?: () => void;
  /*
  FNXC:ReviewLaneBypass 2026-07-09-00:00:
  Operator-only bypass of the latest failed pre-merge review step (FN-7720).
  Only TaskDetailModal wires `onBypassReview`, so the action is invisible in
  the Board/List card context menus — kept to the single canonical
  task-detail actions surface intentionally.
  */
  onBypassReview?: () => void;
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

export function isPreExecutionHoldColumn(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  if (flags?.complete === true || flags?.archived === true) return false;
  return column === "triage" || flags?.intake === true || flags?.hold === true;
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
    hasBypassReviewHandler = Boolean(options.onBypassReview),
  } = options;
  const isTaskPaused = Boolean(task.paused || task.userPaused);
  const actions: TaskMenuActionDescriptor[] = [];
  const destructiveActions: TaskMenuActionDescriptor[] = [];

  if (hasDuplicateHandler) {
    actions.push({ id: "duplicate", label: t("taskDetail.duplicate.btn", "Duplicate"), onSelect: options.onDuplicate });
  }

  /*
  FNXC:TaskContextMenu 2026-07-13-00:00:
  Plan belongs only to pre-execution hold/intake cards and reuses the inline-create Planning Mode handoff. Omit it entirely unless the host injects `onPlan`, because Planning Mode creates a new task and unwired menu hosts must not show a disabled shell.
  */
  if (options.onPlan && isPreExecutionHoldColumn(task.column, currentColumnFlags)) {
    actions.push({ id: "plan", label: t("taskDetail.plan.openPlanningBtn", "Plan"), onSelect: options.onPlan });
  }

  if (isDoneOrReview(task.column, currentColumnFlags) && options.onOpenRefine) {
    actions.push({ id: "refine", label: t("taskDetail.refine.btn", "Refine"), onSelect: options.onOpenRefine });
  }

  actions.push({ id: "respecify", label: t("taskDetail.respecify.btn", "Respecify"), onSelect: options.onRespecify });

  if (canRetryTask && hasRetryHandler) {
    actions.push({ id: "retry", label: t("taskDetail.retry.btn", "Retry"), onSelect: options.onRetry });
  }

  /*
  FNXC:ReviewLaneBypass 2026-07-09-00:00:
  Policy-gated escape hatch (FN-7720) for a card stranded in `in-review`
  solely by a failed pre-merge review step (leading real-world cause:
  Runfusion/Fusion#1946's no-verdict dispatch defect). Shown only when the
  task is `in-review` and carries a failed pre-merge `WorkflowStepResult`, so
  it never renders as an empty/dead affordance for tasks blocked by other
  reasons or already recovered.
  */
  if (hasBypassReviewHandler && task.column === "in-review" && hasFailedPreMergeReviewStep(task)) {
    actions.push({
      id: "bypass-review",
      label: t("taskDetail.bypassReview.btn", "Bypass failed review"),
      tone: "note",
      onSelect: options.onBypassReview,
    });
  }

  /*
  FNXC:GitHubTracking 2026-07-01-00:00:
  Board and List task menus mirror Task Detail's GitHub tracking enablement with one shared descriptor. Only hosts that can PATCH and refresh local task state inject the callback, so untracked tasks get a working shortcut and already-enabled/linked tasks never leave an empty disabled shell.
  */
  if (options.onEnableGithubTracking && task.githubTracking?.enabled !== true) {
    actions.push({
      id: "enable-github-tracking",
      label: t("taskDetail.githubTracking.enableCheckboxLabel", "Enable GitHub tracking"),
      onSelect: options.onEnableGithubTracking,
    });
  }

  if (hasResetHandler && isMutableLiveColumn(task.column, currentColumnFlags)) {
    destructiveActions.push({ id: "reset", label: t("taskDetail.reset.btn", "Reset"), tone: "danger", onSelect: options.onReset });
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

  destructiveActions.push({
    id: "delete",
    label: t("taskDetail.delete.btn", "Delete"),
    tone: "danger",
    onSelect: options.onDelete,
  });
  /*
  FNXC:TaskContextMenu 2026-07-01-00:00:
  Popup context menus intentionally group destructive Reset and Delete actions at the bottom, with Delete last, so Board, List, and Detail hosts share the safer operator action order without forking availability or confirmation behavior.
  */
  actions.push(...destructiveActions);

  return {
    actions,
    moveTransitions: getTaskMoveTransitions(task, t, columnLabel, workflowMoveColumns),
    reviewAction: getTaskReviewAction(task, options),
    shouldShowActionsMenu:
      task.column !== "triage" ||
      task.status === "awaiting-approval" ||
      canRetryTask ||
      isTaskPaused ||
      hasAssignedAgent ||
      Boolean(options.onEnableGithubTracking && task.githubTracking?.enabled !== true),
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
  const touchSelectedActionRef = useRef<{ id: string; at: number } | null>(null);

  const selectAction = useCallback((action: TaskMenuActionDescriptor) => {
    if (action.disabled || action.tone === "note" || !action.onSelect) return;
    onActionSelect?.(action);
    action.onSelect();
  }, [onActionSelect]);

  /*
  FNXC:TaskContextMenu 2026-07-01-00:00:
  Mobile task menus must commit the selected action on touch/pen pointer release before host popovers can be removed by outside-click or focus retargeting. Desktop mouse keeps click activation, while the click guard prevents synthesized mobile clicks from firing the same task action twice.
  */
  const handleActionPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>, action: TaskMenuActionDescriptor) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    touchSelectedActionRef.current = { id: action.id, at: Date.now() };
    selectAction(action);
  }, [selectAction]);

  const handleActionClick = useCallback((event: ReactMouseEvent<HTMLButtonElement>, action: TaskMenuActionDescriptor) => {
    const touchSelection = touchSelectedActionRef.current;
    if (touchSelection?.id === action.id && Date.now() - touchSelection.at < 1000) {
      event.preventDefault();
      event.stopPropagation();
      touchSelectedActionRef.current = null;
      return;
    }
    touchSelectedActionRef.current = null;
    selectAction(action);
  }, [selectAction]);

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
            onPointerUp={(event) => handleActionPointerUp(event, action)}
            onClick={(event) => handleActionClick(event, action)}
          >
            {action.label}
          </button>
        );

        return <Fragment key={action.id}>{renderAction ? renderAction(action, defaultNode) : defaultNode}</Fragment>;
      })}
    </div>
  );
}
