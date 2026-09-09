import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { isCompleteColumnRole } from "../utils/columnRoles";
import { isTaskReverted } from "../utils/taskRevert";
import type { GithubIssueAction, Task, TaskDetail } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import { TaskCard } from "./TaskCard";
import "./DockTaskList.css";

export interface DockTaskListProps {
  /** Per-task resolved column traits, from the dock's render props. */
  columnFlagsByTaskId?: ReadonlyMap<string, Parameters<typeof isCompleteColumnRole>[0]>;
  tasks: Array<Task | TaskDetail>;
  projectId?: string;
  onOpenTask?: (task: Task | TaskDetail) => void;
  onReviseTask?: (task: Task) => void;
  onUpdateTask?: (id: string, updates: { title?: string; description?: string; dependencies?: string[]; dismissNearDuplicate?: boolean; githubTracking?: { enabled?: boolean } }) => Promise<Task>;
  onDeleteTask?: (id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; githubIssueAction?: GithubIssueAction; allowResurrection?: boolean }) => Promise<Task>;
  onOpenChatWithPrefill?: (prefillText: string) => void;
  addToast?: (message: string, type?: ToastType) => void;
  prAuthAvailable?: boolean;
  autoMergeEnabled?: boolean;
}

/*
FNXC:RightDockTasks 2026-06-28-16:50:
The Tasks tab empty state is a real compact task list, not a blank placeholder. TaskCard's own open callback is routed directly to `onOpenTask` so clicking the card opens the dock Tasks detail with the back button; no wrapper click handler competes with TaskCard or the full-panel detail modal.

FNXC:RightDockTasks 2026-06-28-18:25:
The compact right-dock Tasks list is an active-work queue by default. It hides completed work until the local Show Done toggle is enabled, including in the expanded dock modal that reuses this component.
*/
/*
FNXC:RightDockTasks 2026-07-22-12:05:
Row-key helper: the first occurrence of an id keys as the bare id (stable across reorders — no remount), later occurrences of the same id get an occurrence suffix so duplicate-id data never produces React duplicate-key warnings.
*/
function dockRowKey(taskId: string, index: number, list: Array<Task | TaskDetail>): string {
  let occurrence = 0;
  for (let i = 0; i < index; i += 1) {
    if (list[i].id === taskId) occurrence += 1;
  }
  return occurrence === 0 ? taskId : `${taskId}--dup-${occurrence}`;
}

export function DockTaskList({ columnFlagsByTaskId,
  tasks,
  projectId,
  onOpenTask,
  onDeleteTask,
  onReviseTask,
  onUpdateTask,
  onOpenChatWithPrefill,
  addToast = () => {},
  prAuthAvailable = false,
  autoMergeEnabled = false,
}: DockTaskListProps) {
  /*
  FNXC:NearDuplicateDetection 2026-08-23-04:10:
  A host that renders a duplicate tag must also pass its clear action, otherwise a triage hold has no UI release.
  */
  const { t } = useTranslation("app");
  const [showDone, setShowDone] = useState(false);

  const handleOpenTask = useCallback((task: Task | TaskDetail) => {
    onOpenTask?.(task);
  }, [onOpenTask]);

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-04:00 (batch-dashboard-app — the dock-wide fix landed):
  The resolved completion role decides what the right dock lists: completed cards are grouped and shown
  only behind `showDone`. Keying this on `done` alone failed for renamed workflows.

  Previously sized as blocked, because this component mounts only through `overflowViewRegistry` and
  those render props carried no flags. That gap is now closed at the source — App threads the map it
  already builds for the footer through useRightDockController into the registry — so the same change
  also fixes DevServerView's dock surface. Per TASK, not per column id.
  */
  const isTerminal = useCallback((task: Task | TaskDetail) => {
    const flags = columnFlagsByTaskId?.get(task.id);
    return { complete: isCompleteColumnRole(flags, task.column) };
  }, [columnFlagsByTaskId]);
  /*
  FNXC:TaskRevert 2026-08-27-02:34:
  Reverted cards now follow normal dock visibility rather than a separate deduplicated section.
  Collapse only duplicate reverted ids so refetch overlap cannot render the same resolution card twice.
  */
  const displayTasks = useMemo(() => {
    const seenRevertedTaskIds = new Set<string>();
    return tasks.filter((task) => {
      if (!isTaskReverted(task.sourceMetadata)) return true;
      if (seenRevertedTaskIds.has(task.id)) return false;
      seenRevertedTaskIds.add(task.id);
      return true;
    });
  }, [tasks]);
  const doneTasks = useMemo(() => displayTasks.filter((task) => isTerminal(task).complete), [displayTasks, isTerminal]);
  const visibleTasks = useMemo(() => displayTasks.filter((task) => {
    const roles = isTerminal(task);
    if (roles.complete) return showDone;
    return true;
  }), [displayTasks, showDone, isTerminal]);
  const hasDoneTasks = doneTasks.length > 0;
  const isEmpty = visibleTasks.length === 0;
  const emptyTitle = tasks.length === 0 ? t("rightDock.noTasksYet", "No tasks yet") : t("rightDock.noActiveTasks", "No active tasks");
  const emptyCopy = tasks.length === 0
    ? t("rightDock.emptyCopy", "Tasks you create or import will appear here for quick right-sidebar review.")
    : hasDoneTasks
      ? t("rightDock.doneHiddenCopy", "Completed tasks are hidden until you choose Show Done.")
      : t("rightDock.emptyCopy", "Tasks you create or import will appear here for quick right-sidebar review.");
  const toggleLabel = showDone ? t("rightDock.hideDone", "Hide Done") : t("rightDock.showDone", "Show Done");

  return (
    <div className={`dock-task-list${isEmpty ? " dock-task-list--empty" : ""}`} data-testid="dock-task-list">
      {hasDoneTasks ? (
        <div className="dock-task-list__controls">
          <button
            type="button"
            className="btn dock-task-list__toggle-done"
            aria-pressed={showDone}
            onClick={() => setShowDone((current) => !current)}
          >
            {toggleLabel}
          </button>
        </div>
      ) : null}
      {isEmpty ? (
        <div className="dock-task-list__empty" data-testid="dock-task-list-empty">
          <p className="dock-task-list__empty-title">{emptyTitle}</p>
          <p className="dock-task-list__empty-copy">{emptyCopy}</p>
        </div>
      ) : visibleTasks.map((task, index, list) => (
        /*
        FNXC:RightDockTasks 2026-07-22-12:05:
        Rows are keyed by task.id (with an occurrence suffix only for duplicate ids). The old `${task.id}-${index}` key remounted every surviving TaskCard on any reorder, filter toggle, or status change, discarding card-local state (open menus, edit drafts).
        Keying by id also guarantees an instance never migrates between tasks, so no stale per-card oversight/authorization state can cross tasks; TaskCard's FN-8251 render guard covers within-instance prop switches.
        Duplicate ids (a data anomaly this list deliberately tolerates) keep distinct identities without duplicate-key warnings via the occurrence count.
        */
        <div key={dockRowKey(task.id, index, list)} className="dock-task-list__row" data-testid={`dock-task-list-row-${task.id}`}>
          <TaskCard
            task={task as Task}
            taskColumnFlags={columnFlagsByTaskId?.get(task.id)}
            projectId={projectId}
            onOpenDetail={handleOpenTask}
            /*
            FNXC:TaskDeletion 2026-07-12-18:04:
            Every task Delete affordance must reach the shared confirm→delete flow. The right-dock Tasks list is a TaskCard host, so it must pass onDeleteTask instead of rendering cards that silently lack/delete-disable the destructive path.
            */
            onDeleteTask={onDeleteTask}
            onReviseTask={onReviseTask}
            onUpdateTask={onUpdateTask}
            onOpenChatWithPrefill={onOpenChatWithPrefill}
            addToast={addToast}
            prAuthAvailable={prAuthAvailable}
            autoMergeEnabled={autoMergeEnabled}
          />
        </div>
      ))}
    </div>
  );
}
