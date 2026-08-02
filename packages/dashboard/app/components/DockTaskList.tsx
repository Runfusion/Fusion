import { useCallback, useMemo, useState } from "react";
import { isArchivedColumnRole, isCompleteColumnRole } from "../utils/columnRoles";
import { partitionRevertedTasks } from "../utils/taskRevert";
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
  onDeleteTask?: (id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; githubIssueAction?: GithubIssueAction; allowResurrection?: boolean }) => Promise<Task>;
  addToast?: (message: string, type?: ToastType) => void;
  prAuthAvailable?: boolean;
  autoMergeEnabled?: boolean;
}

/*
FNXC:RightDockTasks 2026-06-28-16:50:
The Tasks tab empty state is a real compact task list, not a blank placeholder. TaskCard's own open callback is routed directly to `onOpenTask` so clicking the card opens the dock Tasks detail with the back button; no wrapper click handler competes with TaskCard or the full-panel detail modal.

FNXC:RightDockTasks 2026-06-28-18:25:
The compact right-dock Tasks list is an active-work queue by default. It hides completed work until the local Show Done toggle is enabled and never renders archived tasks, including in the expanded dock modal that reuses this component.
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
  addToast = () => {},
  prAuthAvailable = false,
  autoMergeEnabled = false,
}: DockTaskListProps) {
  const [showDone, setShowDone] = useState(false);

  const handleOpenTask = useCallback((task: Task | TaskDetail) => {
    onOpenTask?.(task);
  }, [onOpenTask]);

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-04:00 (batch-dashboard-app — the dock-wide fix landed):
  These three decide what the right dock lists: completed cards grouped, archived hidden, done shown
  only behind `showDone`. Keyed on the literals none matched on a renamed board, so the dock showed
  ARCHIVED cards and never grouped completed ones.

  Previously sized as blocked, because this component mounts only through `overflowViewRegistry` and
  those render props carried no flags. That gap is now closed at the source — App threads the map it
  already builds for the footer through useRightDockController into the registry — so the same change
  also fixes DevServerView's dock surface. Per TASK, not per column id.
  */
  const isTerminal = useCallback((task: Task | TaskDetail) => {
    const flags = columnFlagsByTaskId?.get(task.id);
    return { complete: isCompleteColumnRole(flags, task.column), archived: isArchivedColumnRole(flags, task.column) };
  }, [columnFlagsByTaskId]);
  /*
  FNXC:TaskRevert 2026-08-01-20:06:
  Resolution cards must receive the task's resolved traits, not legacy column names.
  A custom complete column otherwise hides the reverted treatment and its Delete and
  Revise actions in the dock even though the same task is correctly partitioned here.
  */
  const revertedTasks = useMemo(() => partitionRevertedTasks(tasks as Task[]).reverted, [tasks]);
  const doneTasks = useMemo(() => tasks.filter((task) => isTerminal(task).complete && !revertedTasks.some((reverted) => reverted.id === task.id)), [tasks, isTerminal, revertedTasks]);
  const visibleTasks = useMemo(() => tasks.filter((task) => {
    const roles = isTerminal(task);
    if (roles.archived) return false;
    if (revertedTasks.some((reverted) => reverted.id === task.id)) return false;
    if (roles.complete) return showDone;
    return true;
  }), [showDone, tasks, isTerminal, revertedTasks]);
  const hasDoneTasks = doneTasks.length > 0;
  const isEmpty = visibleTasks.length === 0;
  const emptyTitle = tasks.length === 0 ? "No tasks yet" : "No active tasks";
  const emptyCopy = tasks.length === 0
    ? "Tasks you create or import will appear here for quick right-sidebar review."
    : hasDoneTasks
      ? "Completed tasks are hidden until you choose Show Done. Archived tasks stay out of this compact sidebar."
      : "Archived tasks stay out of this compact sidebar. Active tasks will appear here when work is available.";
  const toggleLabel = showDone ? "Hide Done" : "Show Done";

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
      {revertedTasks.length > 0 && (
        <section className="dock-task-list__reverted" aria-label="Reverted Tasks" data-testid="dock-reverted-tasks">
          <h3>Reverted Tasks</h3>
          {revertedTasks.map((task) => <TaskCard key={`reverted-${task.id}`} task={task} taskColumnFlags={columnFlagsByTaskId?.get(task.id)} projectId={projectId} onOpenDetail={handleOpenTask} onDeleteTask={onDeleteTask} onReviseTask={onReviseTask} addToast={addToast} disableDrag />)}
        </section>
      )}
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
            projectId={projectId}
            onOpenDetail={handleOpenTask}
            /*
            FNXC:TaskDeletion 2026-07-12-18:04:
            Every task Delete affordance must reach the shared confirm→delete flow. The right-dock Tasks list is a TaskCard host, so it must pass onDeleteTask instead of rendering cards that silently lack/delete-disable the destructive path.
            */
            onDeleteTask={onDeleteTask}
            addToast={addToast}
            disableDrag={true}
            prAuthAvailable={prAuthAvailable}
            autoMergeEnabled={autoMergeEnabled}
          />
        </div>
      ))}
    </div>
  );
}
