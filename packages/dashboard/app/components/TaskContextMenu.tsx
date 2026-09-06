import "./TaskContextMenu.css";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import type { ColumnId, Task, TaskDetail, WorkflowStepResult } from "@fusion/core";
import { isReviewColumnRole } from "../utils/columnRoles";

/*
FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
FN-206 makes dashboard task recovery Retry, Reset, and Delete. Retry repeats the current stage
in place; Reset abandons task state; Delete removes the card.
*/

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
/*
FNXC:ReviewLaneBypass 2026-09-06-00:47:
Dashboard imports only core types, so this predicate mirrors the core selector. An archived failed
carrier retains history yet must stay reachable by the audited operator bypass.
*/
function hasFailedPreMergeReviewStep(task: Pick<Task, "workflowStepResults">): boolean {
  return (task.workflowStepResults ?? []).some((result: WorkflowStepResult) =>
    (result.phase || "pre-merge") === "pre-merge"
    && (result.status === "failed" || (result.remediationArchivedAt != null
      && (result.remediationArchivedFromStatus === "failed" || result.remediationArchivedFromStatus === "advisory_failure")
      && !result.bypassedBy
      && !result.supersededAt)),
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

/**
 * A non-action menu parent whose children are the selectable menu items.
 *
 * FNXC:TaskContextMenu 2026-08-27-12:01:
 * FN-198 removed the only in-repository producer, but this host-agnostic renderer stays because
 * submenu support is generic menu infrastructure rather than a task-relocation capability.
 */
export interface TaskMenuSubmenuDescriptor {
  id: string;
  label: string;
  items: TaskMenuActionDescriptor[];
}

export type TaskMenuItemDescriptor = TaskMenuActionDescriptor | TaskMenuSubmenuDescriptor;

export interface TaskContextMenuColumnFlags {
  complete?: boolean;
  archived?: boolean;
  hiddenFromBoard?: boolean;
  hold?: boolean;
  intake?: boolean;
  /** Intake WITHOUT auto-triage: the operator promotes the card by hand. */
  manualIntake?: boolean;
  mergeBlocker?: boolean;
  humanReview?: boolean;
  /* FNXC:WorkflowResolvedColumns 2026-07-27-15:30 (U10 / R8): surfaced so column-trait consumers
     can tell an implementation lane from a pre-implementation one without naming `in-progress`. */
  countsTowardWip?: boolean;
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
  reviewAction?: TaskReviewActionDescriptor;
  shouldShowActionsMenu: boolean;
  isTaskPaused: boolean;
}

export interface BuildTaskActionMenuModelOptions {
  task: Task | TaskDetail;
  t: TFunction<"app">;
  currentColumnFlags?: TaskContextMenuColumnFlags;
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

/*
FNXC:TaskContextMenu 2026-07-30-04:10 DELIBERATE-LITERAL: the no-metadata fallback only.
Reached when the caller supplies no resolved flags — the pre-load window before the board's
workflows fetch resolves, and a card stranded on an id its workflow no longer declares. Nothing to
resolve from in either state, so deleting the id does not remove a decision, it answers "not a
review column" for every card during first paint.

NOTE, flagged not fixed: the id is currently an UNCONDITIONAL disjunct, so explicit
`{ mergeBlocker: false, humanReview: false }` on a column named `in-review` is still classified as
review. #2664 fixed exactly that shape in `isPreExecutionHoldColumn` (traits first, id as fallback).
Same fix belongs here, but it is a BEHAVIOR CHANGE and out of scope for a conversion batch.
*/
function isReviewColumn(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  return column === "in-review" || flags?.mergeBlocker === true || flags?.humanReview === true;
}

/*
FNXC:TaskContextMenu 2026-07-30-04:10 DELIBERATE-LITERAL: the no-metadata fallback only, same
reasoning as `isReviewColumn` above — and the same flagged inversion: `column === "done"` is an
unconditional disjunct ahead of the trait read.
*/
function isDoneOrReview(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  return column === "done" || isReviewColumn(column, flags) || (flags?.complete === true && flags?.archived !== true);
}

/*
FNXC:TaskContextMenu 2026-07-30-04:10 DELIBERATE-LITERAL: the no-metadata fallback only.
Same rule as `isReviewColumn` above: reached when no resolved flags arrive, where answering
"mutable" for a done/archived card would offer live-work actions on a terminal one.
*/
function isMutableLiveColumn(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  if (flags) return flags.complete !== true && flags.archived !== true;
  return column !== "done" && column !== "archived";
}

export function isPreExecutionHoldColumn(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  if (flags?.complete === true || flags?.archived === true) return false;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-18:35 (Phase B — AUDITED, deliberately NOT consolidated):
  `isPreImplementationColumnRole` in `utils/columnRoles.ts` answers a near-identical question and I
  routed this through it — then reverted, because its DEGRADED-MODE answer is wider than this one's.

  Its legacy set is {todo, triage}; this predicate's was {triage} alone. They differ for a reason:
  that helper drives the preserve-progress prompt, where a flagless `todo` should prompt (losing
  steps is unrecoverable), while THIS drives the Plan affordance, where a flagless `todo` must not
  offer to re-plan a card that may already be planned. Consolidating added `plan` to flagless `todo`
  cards — caught by "exposes Plan only for pre-execution hold columns".

  Same shape, different degraded answer: the trait path is identical and the fallbacks are not
  interchangeable. Kept separate with the difference recorded, rather than made to look shared.
  */
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-08:00 (U12 — the LAST `triage` column guard):
  FLAGS-FIRST, id only as the degraded answer. It used to OR the legacy id with the traits
  UNCONDITIONALLY, which is not a fallback: a resolved column that happens to be named `triage` but
  whose traits say it is mid-flight answered true, offering Plan on a card that is already executing.

  The degraded set stays {triage} ALONE — deliberately not the {todo, triage} used by
  `isPreImplementationColumnRole`, for the reason recorded above: that helper drives the
  preserve-progress prompt where a flagless `todo` should prompt, while this drives the Plan
  affordance where a flagless `todo` must not offer to re-plan a possibly-planned card.

  Behaviour delta is exactly the inversion. Flags absent: unchanged (`column === "triage"`). Flags
  present and intake/hold: unchanged (true). Flags present, name `triage`, traits mid-flight: was
  true, now false — which is the defect.

  DELIBERATE-LITERAL: the surviving `triage` is the DEGRADED answer, not an unconverted guard, and it
  is the last `triage` comparison in production source. Converting it is not available — there is no
  trait to read when `flags` is undefined, which happens during first paint and for a card in a column
  its workflow no longer declares. Deleting it would silently withdraw Plan from exactly the stranded
  cards that need re-planning most.

  So the census reaching zero for `triage` means "no unconverted guards remain", not "the string is
  gone". Recorded here rather than achieved by deleting a fallback to move a number.
  */
  return flags ? (flags.intake === true || flags.hold === true) : column === "triage";
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
    currentColumnFlags,
    hasDuplicateHandler = Boolean(options.onDuplicate),
    hasRetryHandler = Boolean(options.onRetry),
    hasResetHandler = Boolean(options.onReset),
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

  /*
  FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
  Retry is not a failure-only escape hatch: a live intake, implementation, or review card can
  always repeat its current stage. Terminal columns remain immutable through the shared trait/id
  predicate, including first paint before workflow metadata is available.
  */
  if (hasRetryHandler && isMutableLiveColumn(task.column, currentColumnFlags)) {
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
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:50 (batch-dashboard-app):
  REVIEW role, resolved from `currentColumnFlags` — which this function already receives and already
  uses for the archived check ~15 lines up. Keyed on the literal, the "Bypass failed review" action
  never appeared on a renamed board, so an operator with a genuinely failed pre-merge review step had
  no way to clear it from the menu and the card stayed merge-blocked with no affordance.
  */
  if (hasBypassReviewHandler && isReviewColumnRole(currentColumnFlags, task.column) && hasFailedPreMergeReviewStep(task)) {
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
    reviewAction: getTaskReviewAction(task, options),
    /*
    FNXC:TaskRecoveryVocabulary 2026-08-28-00:38:
    A pure intake lane is the planning form of Retry, not a reason to hide recovery. Deriving
    visibility from the produced action list keeps every host reachable and prevents a live card
    from showing neither a recovery action nor an explanation.
    */
    shouldShowActionsMenu: actions.length > 0,
    isTaskPaused,
  };
}

export interface TaskContextMenuProps {
  actions: TaskMenuItemDescriptor[];
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
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const [submenuOpensLeft, setSubmenuOpensLeft] = useState(false);

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

  /*
  FNXC:TaskContextMenu 2026-07-16-20:50 (FN-8178):
  Menus are portaled while their TaskCard/ListView hosts close on capture-phase board scroll. Focusing
  the first action must not scroll a board ancestor, because that focus-created scroll is not an
  explicit dismissal and previously closed the menu immediately. Preserve keyboard focus while
  `preventScroll` leaves real user scrolling available to close the menu.
  */
  useEffect(() => {
    if (!autoFocusFirstItem) return;
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    firstItem?.focus({ preventScroll: true });
  }, [actions, autoFocusFirstItem]);

  useEffect(() => {
    if (!openSubmenuId) return;
    menuRef.current?.querySelector<HTMLButtonElement>(`[data-task-submenu="${openSubmenuId}"] button:not(:disabled)`)?.focus({ preventScroll: true });
  }, [openSubmenuId]);

  /*
  FNXC:TaskCardMovement 2026-08-19-18:52:
  The root menu is clamped to the viewport, but a nested Move to menu can still overflow from a
  rightmost Board lane or dock. Measure its rendered edge before paint and flip it left so every
  legal destination remains reachable with mouse, keyboard, and touch.
  */
  useLayoutEffect(() => {
    if (!openSubmenuId) {
      setSubmenuOpensLeft(false);
      return;
    }
    setSubmenuOpensLeft((submenuRef.current?.getBoundingClientRect().right ?? 0) > window.innerWidth);
  }, [openSubmenuId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const activeSubmenu = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-task-submenu]");
    if (event.key === "Escape" && activeSubmenu) {
      event.preventDefault();
      event.stopPropagation();
      setOpenSubmenuId(null);
      menuRef.current?.querySelector<HTMLButtonElement>(`[data-task-submenu-toggle="${activeSubmenu.dataset.taskSubmenu}"]`)?.focus();
      return;
    }
    if (event.key === "ArrowLeft" && activeSubmenu) {
      event.preventDefault();
      setOpenSubmenuId(null);
      menuRef.current?.querySelector<HTMLButtonElement>(`[data-task-submenu-toggle="${activeSubmenu.dataset.taskSubmenu}"]`)?.focus();
      return;
    }
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
      {actions.map((item) => {
        if ("items" in item) {
          const isOpen = openSubmenuId === item.id;
          return (
            <div className="task-context-menu__submenu-parent" key={item.id}>
              <button
                type="button"
                className={`${itemClassName} task-context-menu__submenu-toggle`}
                role={role === "menu" ? "menuitem" : undefined}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                data-task-submenu-toggle={item.id}
                onClick={() => setOpenSubmenuId((current) => current === item.id ? null : item.id)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  setOpenSubmenuId(item.id);
                }}
              >
                {item.label}
              </button>
              {isOpen && (
                <div
                  ref={submenuRef}
                  className={`task-context-menu__submenu${submenuOpensLeft ? " task-context-menu__submenu--opens-left" : ""}`}
                  role="menu"
                  data-task-submenu={item.id}
                >
                  {item.items.map((action) => {
                    const classes = [itemClassName, "task-context-menu__submenu-item"];
                    if (action.tone === "danger") classes.push(dangerItemClassName);
                    return (
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
                  })}
                </div>
              )}
            </div>
          );
        }
        const action = item;
        const classes = [itemClassName];
        if (action.tone === "danger") classes.push(dangerItemClassName);
        if (action.tone === "note") classes.push(noteItemClassName);
        const defaultNode = action.tone === "note" ? (
          <span key={action.id} className={classes.join(" ")} role="note">{action.label}</span>
        ) : (
          <button key={action.id} type="button" className={classes.join(" ")} role={role === "menu" ? "menuitem" : undefined} disabled={action.disabled} onPointerUp={(event) => handleActionPointerUp(event, action)} onClick={(event) => handleActionClick(event, action)}>{action.label}</button>
        );
        return <Fragment key={action.id}>{renderAction ? renderAction(action, defaultNode) : defaultNode}</Fragment>;
      })}
    </div>
  );
}
