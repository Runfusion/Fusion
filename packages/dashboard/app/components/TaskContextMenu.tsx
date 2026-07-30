import "./TaskContextMenu.css";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { Fragment, useCallback, useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import type { ColumnId, Task, TaskDetail, WorkflowStepResult } from "@fusion/core";
import { VALID_TRANSITIONS, isColumn } from "@fusion/core";
import { isIntakeColumnRole, isReviewColumnRole } from "../utils/columnRoles";
// `COLUMNS` is gone from this file: deleting the default-column-set shortcut removed
// the last use. `VALID_TRANSITIONS` survives ONLY for the no-metadata load window (see
// the note at `moveTransitions`); every workflow-resolved path now reads the payload's
// own `moveTargets` adjacency.

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
  /** Columns this one may move to, from the workflow's own graph adjacency. Optional:
   *  a payload predating the field falls back to the neighbour approximation. */
  moveTargets?: readonly string[];
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

/**
 * A PURE intake lane — intake without hold. A merged Planning column carries both, so it is not
 * "pure intake": cards rest there waiting for capacity and have real actions.
 */
function isPureIntakeColumn(column: string, flags?: TaskContextMenuColumnFlags): boolean {
  // With traits, "pure" means intake WITHOUT hold — a merged Planning column carries both and is
  // therefore not pure. Without traits, defer to the shared intake role so the degraded-mode id
  // list lives in exactly one place.
  if (flags) return flags.intake === true && flags.hold !== true;
  return isIntakeColumnRole(undefined, column);
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


/*
FNXC:TaskContextMenu 2026-06-30-12:42:
Workflow-column Board/List menus derive move targets from the task's workflow metadata instead of legacy VALID_TRANSITIONS. Built-in/default workflows keep exact legacy parity; custom workflows use visible neighbor columns and trait flags so custom complete/archived lanes are not treated as mutable live work.

FNXC:TaskContextMenu 2026-06-30-13:02:
Manual pull-request review has two separate operator intents: Start PR Review opens PR creation, while Merge & Close calls the merge endpoint. Keep distinct callbacks so card/list context menus cannot merge a task when the user asked to create a PR.
*/
function getWorkflowMoveTargets(task: Task | TaskDetail, columns: readonly TaskContextMenuColumnMetadata[]): ColumnId[] {
  const visibleColumns = columns.filter((column) => column.flags?.hiddenFromBoard !== true);
  /*
  FNXC:TaskContextMenu 2026-07-29-00:00 (U12 — R8):
  REAL ADJACENCY, when the payload carries it. `moveTargets` comes from
  `resolveAllowedColumns` — the same resolver `moveTaskInternal` validates against — so
  the menu offers exactly what the store will accept, for ANY workflow.

  This replaces the `VALID_TRANSITIONS` shortcut that used to run whenever a workflow's
  column-id set matched the six built-ins. That shortcut existed because the fallback
  below approximates targets from a column's NEIGHBOURS in declared order, which is
  strictly weaker than the graph (in-progress: 4 real targets vs 2 neighbours), so
  deleting it without adjacency would have SHRUNK every default-workflow move menu.

  With adjacency on the wire the shortcut is not merely removable, it is redundant:
  `resolveAllowedColumns(BUILTIN_CODING_WORKFLOW_IR, c)` is byte-identical to
  `VALID_TRANSITIONS[c]` for all six columns, ORDER included — measured, and pinned by
  `@fusion/core`'s `builtin-adjacency-matches-legacy-transitions` test so the
  equivalence cannot drift silently. Custom workflows stop being guessed at.

  Targets are filtered to columns this board can show, so an adjacency edge into a
  hidden column never becomes a dead menu entry.
  */
  const declaredTargets = columns.find((column) => column.id === task.column)?.moveTargets;
  if (declaredTargets) {
    const visibleIds = new Set(visibleColumns.map((column) => column.id));
    return declaredTargets.filter((target) => visibleIds.has(target)) as ColumnId[];
  }

  const currentIndex = visibleColumns.findIndex((column) => column.id === task.column);
  /*
  FNXC:WorkflowResolvedColumns 2026-07-27-14:55 (U10 / R8):
  A card resting in a column its workflow no longer declares used to get an EMPTY move list —
  the one surface that could rescue it offered nothing, so the card was stranded until an engine
  sweep re-homed it. Offer the workflow's own recovery lane instead (intake, else hold, else the
  first live lane), which is the same target `resolveReboundTarget` picks engine-side. Undeclared
  columns are produced by a workflow edit that drops a lane and by U11's Todo→Planning merge for
  rows still stored in `todo`.
  */
  if (currentIndex < 0) {
    const liveColumns = visibleColumns.filter(
      (column) => column.flags?.complete !== true && column.flags?.archived !== true,
    );
    const recoveryColumn = liveColumns.find((column) => column.flags?.intake === true)
      ?? liveColumns.find((column) => column.flags?.hold === true)
      ?? liveColumns[0];
    return recoveryColumn ? [recoveryColumn.id] : [];
  }
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
  /*
  FNXC:TaskContextMenu 2026-07-29-00:00 (U12 — R8, decision recorded):
  The no-metadata `VALID_TRANSITIONS` fallback is KEPT. I removed it first, on the R8
  principle, and measured the result: `workflowMoveColumns` is optional at both call
  sites (`workflowMoveMetadata?.moveColumns`, `taskMoveColumns`) and is genuinely
  undefined until board-workflows resolves, so dropping it left Task Detail with NO
  move options during load — a live surface degraded to satisfy a purity rule. That is
  a regression, not a cleanup, so it is not shipped.

  Unlike Board and ListView, where the legacy path was provably unreachable, this one
  is reachable and useful. It is retired the same way the shortcut above is: by putting
  each column's allowed targets on the board-workflows payload so the load window has
  real data instead of a guess.
  */
  /*
  FNXC:TaskContextMenu 2026-07-30-04:10 DELIBERATE-LITERAL: legacy move-target path.
  Reached only when `workflowMoveColumns` is absent — the payload carries no adjacency, so there is
  no workflow to ask and `VALID_TRANSITIONS` (a closed six-id map) is the only table available. The
  resolved path above it is the live answer for every workflow-aware caller.
  */
  const moveTransitions: ColumnId[] = workflowMoveColumns
    ? getWorkflowMoveTargets(task, workflowMoveColumns)
    : isColumn(task.column)
      ? (task.column === "in-review" ? ["todo", "in-progress"] : [...VALID_TRANSITIONS[task.column]])
      : [];
  const visibleOrdered = (workflowMoveColumns ?? []).filter((column) => column.flags?.hiddenFromBoard !== true);
  const workflowLabelById = new Map(visibleOrdered.map((column) => [column.id, column.label]));
  /*
  FNXC:TaskContextMenu 2026-07-29-00:00 (U12 — R8):
  "Back to X" is derived from COLUMN TRAITS, not from the literals `in-review` and
  `in-progress`. The old condition (`column === "in-progress" && task.column ===
  "in-review"`) hardcoded two lifecycle ids AND a hardcoded English label ("Back to In
  Progress"), so on a workflow that renames those columns it either failed to fire or
  announced a column name that is not on the board.

  The rule it was expressing is "leaving the review lane backwards into the work lane",
  which the traits already say: the CURRENT column carries `mergeBlocker`, the TARGET
  carries `countsTowardWip`. For builtin:coding those are exactly in-review and
  in-progress, so the labelled set is unchanged — deliberately. I first generalised
  this to "any target earlier in the workflow order", which is arguably nicer but
  relabels moves this change never set out to touch (18 assertion sites across three
  suites would have flipped from "Move to" to "Back to"). Same-set-different-derivation
  is the honest scope here; widening which moves read as backwards is a separate,
  visible product decision.

  Load window (no metadata): fall back to the legacy id pair, matching the fallback
  already kept for the targets themselves a few lines below.
  */
  const flagsById = new Map(visibleOrdered.map((column) => [column.id, column.flags]));
  const orderById = new Map(visibleOrdered.map((column, index) => [column.id, index]));
  const currentFlags = flagsById.get(task.column);
  const currentOrder = orderById.get(task.column);
  const isBackwardsLabel = (target: ColumnId): boolean => {
    if (visibleOrdered.length === 0) {
      /*
      FNXC:TaskContextMenu 2026-07-30-04:10 DELIBERATE-LITERAL: degraded ordering only.
      Reached when `visibleOrdered` is empty, i.e. no resolved column order arrived — there is no
      order to compare against, so the legacy pair is the only "is this backwards?" answer left.
      */
      return target === "in-progress" && task.column === "in-review";
    }
    /*
    FNXC:TaskContextMenu 2026-07-29-00:00 (PR #2521 review — greptile):
    DIRECTION as well as traits. The traits alone say "review lane -> work lane", but a
    workflow may declare a `countsTowardWip` column AFTER its `mergeBlocker` one (a
    rework or hotfix lane placed downstream of review). Labelling that "Back to" would
    call a FORWARD move backwards — the same class of wrongness as the hardcoded ids
    this predicate replaced, just arrived at differently.

    Requiring the target to sit EARLIER in the workflow's declared order keeps the
    builtin:coding set unchanged (in-progress precedes in-review) while making the
    label mean what it says on any column layout.
    */
    if (currentOrder === undefined) return false;
    const targetOrder = orderById.get(target);
    if (targetOrder === undefined || targetOrder >= currentOrder) return false;
    return currentFlags?.mergeBlocker === true && flagsById.get(target)?.countsTowardWip === true;
  };

  return moveTransitions.map((column) => {
    const label = workflowLabelById.get(column) ?? columnLabel(column);
    return {
      column,
      label: isBackwardsLabel(column)
        ? t("taskDetail.move.backTo", "Back to {{column}}", { column: label })
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

  /*
  FNXC:TaskContextMenu 2026-07-16-12:00:
  Archived is an unsupported Respecify source: the rebuild route rejects it rather than
  resurrecting intentionally archived work into a planner lane. Check both the semantic
  workflow trait and legacy id so every menu host omits this dead affordance.
  */
  /* DELIBERATE-LITERAL — belt-and-braces, and the comment above says so: this checks BOTH the
     resolved trait and the legacy id on purpose, so a host that supplies no flags still omits the
     dead affordance. Dropping the literal would re-open it for exactly those hosts. */
  if (task.column !== "archived" && currentColumnFlags?.archived !== true) {
    actions.push({ id: "respecify", label: t("taskDetail.respecify.btn", "Respecify"), onSelect: options.onRespecify });
  }

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
    moveTransitions: getTaskMoveTransitions(task, t, columnLabel, workflowMoveColumns),
    reviewAction: getTaskReviewAction(task, options),
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-15:25 (Phase B — TaskContextMenu.tsx):
    Was `task.column !== "triage"`. The intent is "a bare card sitting in a pure INTAKE lane has no
    actions worth showing yet" — `triage` happened to be that lane, and `todo` (hold) always showed
    the menu because cards waiting for capacity have real actions.

    Post-U11 the literal inverts: a default Planning card is `todo`, so `!== "triage"` is true and
    the menu shows unconditionally — which is right for the hold half, but the guard has stopped
    distinguishing anything and would also show a full menu on a bare Coding (Ideas) capture.

    Resolved to `intake AND NOT hold` — a PURE intake lane — which reproduces every shape:
      legacy `triage`   intake only        -> suppressed (as before)
      legacy `todo`     hold only          -> shown (as before)
      merged Planning   intake + hold      -> shown (matches the Todo half, where cards wait)
      Ideas `ideas`     intake only        -> suppressed (a bare captured idea)
    Falls back to the legacy id when no flags are supplied, so unwired menu hosts are unchanged.
    */
    shouldShowActionsMenu:
      !isPureIntakeColumn(task.column, currentColumnFlags) ||
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
