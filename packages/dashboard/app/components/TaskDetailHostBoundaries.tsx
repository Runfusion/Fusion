import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Task, TaskDetail } from "@fusion/core";
import { mergeTaskSnapshot } from "../hooks/useTasks";
import { useMainPanelTaskDetail } from "../hooks/useMainPanelTaskDetail";
import { usePoppedOutTasks, type PoppedOutTaskEntry } from "../hooks/usePoppedOutTasks";
import type { DetailTaskTab } from "../hooks/useModalManager";
import type { NavEntry } from "../hooks/useNavigationHistory";
import type { TaskView } from "../hooks/useViewState";
import { FloatingWindow } from "./FloatingWindow";
import { useDashboardWindowSurfaceActivity } from "../context/DashboardWindowManagerContext";
import { TaskDetailContent, TaskDetailModal, type TaskDetailContentProps, type TaskDetailModalProps } from "./TaskDetailModal";

export interface AppModalTaskDetailHostProps extends Omit<TaskDetailModalProps, "onClose"> {
  onRemoveNavigation: () => void;
  onCloseDetail: () => void;
  onCleanupDeepLink: () => void;
  onClosed?: () => void;
}

/*
FNXC:TaskDetailAlpha 2026-09-11-13:24:
Every Task Detail host renders one canonical content surface while retaining ownership of its distinct exit effect. These production boundaries are shared by the real routers and behavioral tests so navigation, selection, dock, and pop-out cleanup cannot be replaced by a test-only callback map.
*/
export function AppModalTaskDetailHost({ onRemoveNavigation, onCloseDetail, onCleanupDeepLink, onClosed, ...props }: AppModalTaskDetailHostProps) {
  const handleClose = useCallback(() => {
    onRemoveNavigation();
    onCloseDetail();
    onCleanupDeepLink();
    onClosed?.();
  }, [onCleanupDeepLink, onCloseDetail, onClosed, onRemoveNavigation]);

  return <TaskDetailModal {...props} onClose={handleClose} />;
}

export interface MainPanelTaskDetailHostProps extends Omit<TaskDetailContentProps, "embedded" | "onBackToBoard" | "onRequestClose"> {
  onNavigateToBoard: () => void;
  mobileTransition?: boolean;
  presentation?: "panel" | "drawer";
}

/*
FNXC:TaskDetailHostOwnership 2026-09-13-16:30:
The Board main-panel host passes its navigation owner through the canonical close boundary in every presentation. TaskDetailContent chooses phone back chrome versus desktop/tablet close chrome, so the host never invents a textual return row or a second drawer header.
*/
export function MainPanelTaskDetailHost({ onNavigateToBoard, mobileTransition = false, presentation = "panel", ...props }: MainPanelTaskDetailHostProps) {
  return (
    <div className={`task-detail-main-panel${mobileTransition ? " task-detail-main-panel--mobile-transition" : ""}`}>
      <div className="task-detail-main-panel-body">
        <TaskDetailContent
          {...props}
          embedded
          onBackToBoard={presentation === "panel" ? onNavigateToBoard : undefined}
          onRequestClose={onNavigateToBoard}
        />
      </div>
    </div>
  );
}

export interface ListSplitTaskDetailHostProps extends Omit<TaskDetailContentProps, "embedded" | "onRequestClose"> {
  onClearSelection: () => void;
}

export function ListSplitTaskDetailHost({ onClearSelection, ...props }: ListSplitTaskDetailHostProps) {
  return (
    <div className="list-split-detail-content" data-testid="list-split-detail-content">
      <TaskDetailContent {...props} embedded onRequestClose={onClearSelection} />
    </div>
  );
}

export interface RightDockTaskDetailHostProps extends Omit<TaskDetailContentProps, "embedded" | "onRequestClose"> {
  onCloseDock: () => void;
}

export function RightDockTaskDetailHost({ onCloseDock, ...props }: RightDockTaskDetailHostProps) {
  return <TaskDetailContent {...props} embedded onRequestClose={onCloseDock} />;
}

export interface AppTaskPopoutContentProps extends Omit<TaskDetailContentProps, "embedded" | "onRequestClose"> {
  onRemoveWindow: () => void;
}

/*
FNXC:TaskWindowIdentity 2026-09-14-17:46:
FN-392: a retained task window suspends its own reads from the GLOBAL visibility manager rather than from the current
view. Navigating never marks the content inactive; only a global hide does, which keeps image pasting and detail
polling paused exactly while the operator cannot see the window.
*/
export function AppTaskPopoutContent({ onRemoveWindow, active, ...props }: AppTaskPopoutContentProps) {
  const surfaceActive = useDashboardWindowSurfaceActivity();
  return <TaskDetailContent {...props} active={(active ?? true) && surfaceActive} embedded onRequestClose={onRemoveWindow} />;
}

export interface AppTaskPopoutWindowProps extends Omit<AppTaskPopoutContentProps, "onRemoveWindow"> {
  onRemoveWindow: () => void;
  persistGeometryKey: string;
  /** Raises the existing window when its owner refreshes the entry in place. */
  raiseToFrontSignal?: number;
}

/*
FNXC:TaskDetailDefinition 2026-09-13-11:59:
Le pop-out n’a pas de titre visible propre; il partage donc le nom accessible localisé de Task Detail avec la modale et le drawer plutôt que d’utiliser le titre retiré ou seulement l’identifiant de tâche.
*/
/*
FNXC:TaskWindowIdentity 2026-09-14-17:46:
FN-392: the window key, React key, and DOM identity are the task id alone, so one task owns one window that travels
across every view of the project. Nothing here derives visibility from the current view: only the global visibility
manager and the owner's own close path may hide or remove this window.
*/
export function AppTaskPopoutWindow({ task, onRemoveWindow, persistGeometryKey, raiseToFrontSignal, ...props }: AppTaskPopoutWindowProps) {
  const { t } = useTranslation("app");
  const accessibleName = t("taskDetail.accessibleName", "Task detail");
  return (
    <FloatingWindow
      windowKey={`task-detail-${task.id}`}
      title={accessibleName}
      ariaLabel={accessibleName}
      raiseToFrontSignal={raiseToFrontSignal}
      onClose={onRemoveWindow}
      hideHeader
      dragHandleSelector=".task-detail-content--embedded > .modal-header"
      className="floating-window--task-detail"
      suspendGeometryPersistenceOnMobile
      persistGeometryKey={persistGeometryKey}
      layer="task-detail"
    >
      <AppTaskPopoutContent {...props} task={task} onRemoveWindow={onRemoveWindow} />
    </FloatingWindow>
  );
}

interface AppTaskDetailNavigation {
  pushNav: (entry: NavEntry) => void;
  removeNav: (callback: () => void) => void;
}

export interface AppMainPanelTaskDetailStateOptions extends AppTaskDetailNavigation {
  taskView: TaskView;
  changeTaskView: (view: TaskView) => void;
  captureBoardScroll: () => void;
  requestBoardScrollRestore: () => void;
}

/*
FNXC:TaskDetailAlpha 2026-09-11-13:46:
App's main-panel boundary owns the detail snapshot and its navigation entry together. Back must consume that entry, restore Board scrolling, clear the snapshot and reset the landing tab; tests exercise this same hook rather than reconstructing only the final callback.
*/
export type AppMainPanelTaskDetailState = ReturnType<typeof useAppMainPanelTaskDetailState>;

export function useAppMainPanelTaskDetailState({
  taskView,
  changeTaskView,
  captureBoardScroll,
  requestBoardScrollRestore,
  pushNav,
  removeNav,
}: AppMainPanelTaskDetailStateOptions) {
  const { task, initialTab, setTask, setInitialTab } = useMainPanelTaskDetail();
  const navRevertRef = useRef<(() => void) | null>(null);

  const open = useCallback((nextTask: Task | TaskDetail, nextTab?: DetailTaskTab) => {
    const previousView = taskView;
    const previousTask = task;
    const previousTab = initialTab;

    if (previousView === "task-detail" && previousTask?.id === nextTask.id && previousTab === nextTab) {
      setTask((current) => current?.id === nextTask.id ? mergeTaskSnapshot(current, nextTask) : nextTask);
      return;
    }
    if (previousView !== "task-detail") captureBoardScroll();

    const revert = () => {
      if (previousView === "task-detail" && previousTask) {
        setTask(previousTask);
        setInitialTab(previousTab);
        changeTaskView("task-detail");
      } else {
        requestBoardScrollRestore();
        setTask(null);
        setInitialTab("chat");
        changeTaskView(previousView);
      }
      navRevertRef.current = null;
    };

    setTask(nextTask);
    setInitialTab(nextTab);
    changeTaskView("task-detail");
    navRevertRef.current = revert;
    pushNav({ type: "view", revert });
  }, [captureBoardScroll, changeTaskView, initialTab, pushNav, requestBoardScrollRestore, setInitialTab, setTask, task, taskView]);

  const close = useCallback(() => {
    const revert = navRevertRef.current;
    if (revert) {
      removeNav(revert);
      navRevertRef.current = null;
    }
    requestBoardScrollRestore();
    setTask(null);
    setInitialTab("chat");
    changeTaskView("board");
  }, [changeTaskView, removeNav, requestBoardScrollRestore, setInitialTab, setTask]);

  return { task, initialTab, setTask, setInitialTab, open, close };
}

export interface AppTaskPopoutWindowsProps {
  entries: PoppedOutTaskEntry[];
  liveTasks: Array<Task | TaskDetail>;
  onCloseTask: (taskId: string) => void;
  persistGeometryKey: string;
  windowProps: Omit<AppTaskPopoutWindowProps, "task" | "initialTab" | "onRemoveWindow" | "persistGeometryKey" | "raiseToFrontSignal" | "active">;
}

/*
FNXC:TaskDetailAlpha 2026-09-11-14:05:
App's pop-out renderer must derive FloatingWindow dismissal from the same state owner that supplied each entry. Keeping entry identity, live snapshot merging, and close binding in this rendered composition prevents host tests from recreating a parallel callback.

FNXC:TaskWindowIdentity 2026-09-14-17:46:
FN-392: one entry renders one window keyed by task id, with no view-derived visibility. Activity comes from the global
window manager through `AppTaskPopoutContent`, so a hidden window still suspends polling and pasting while a mere view
change never interrupts its content, terminal, or local state.
*/
export function AppTaskPopoutWindows({ entries, liveTasks, onCloseTask, persistGeometryKey, windowProps }: AppTaskPopoutWindowsProps) {
  return entries.map(({ task: snapshot, initialTab, focusNonce }) => {
    const current = liveTasks.find((candidate) => candidate.id === snapshot.id);
    const task = current ? mergeTaskSnapshot(snapshot, current) : snapshot;
    return (
      <AppTaskPopoutWindow
        key={snapshot.id}
        {...windowProps}
        task={task}
        initialTab={initialTab}
        raiseToFrontSignal={focusNonce}
        persistGeometryKey={persistGeometryKey}
        onRemoveWindow={() => onCloseTask(snapshot.id)}
      />
    );
  });
}

export interface AppPoppedOutTaskStateOptions extends AppTaskDetailNavigation {
  isMobile: boolean;
}

/*
FNXC:TaskDetailAlpha 2026-09-11-13:46:
App's pop-out boundary owns each window entry and its mobile navigation callback as one state machine. Closing from either FloatingWindow chrome or Task Detail removes the entry and consumes its navigation record.

FNXC:TaskWindowIdentity 2026-09-14-17:46:
FN-392: navigation identity is the task id alone, so reopening the same task from a second view focuses the existing
window and registers no second history callback. The current view no longer participates in identity at all.
*/
export function useAppPoppedOutTaskState({ isMobile, pushNav, removeNav }: AppPoppedOutTaskStateOptions) {
  const { entries, popOut, close: closeEntry, closeAll } = usePoppedOutTasks();
  const navCloseRef = useRef(new Map<string, () => void>());

  const close = useCallback((taskId: string) => {
    const closeFromHistory = navCloseRef.current.get(taskId);
    if (closeFromHistory) {
      navCloseRef.current.delete(taskId);
      removeNav(closeFromHistory);
    }
    closeEntry(taskId);
  }, [closeEntry, removeNav]);

  const open = useCallback((nextTask: Task | TaskDetail, initialTab?: DetailTaskTab) => {
    const alreadyOpen = entries.some((entry) => entry.task.id === nextTask.id);
    if (isMobile && !alreadyOpen) {
      const closeFromHistory = () => {
        navCloseRef.current.delete(nextTask.id);
        closeEntry(nextTask.id);
      };
      navCloseRef.current.set(nextTask.id, closeFromHistory);
      pushNav({ type: "modal", close: closeFromHistory });
    }
    popOut(nextTask, initialTab);
  }, [closeEntry, entries, isMobile, popOut, pushNav]);

  const clearNavigation = useCallback(() => navCloseRef.current.clear(), []);

  return { entries, open, close, closeAll, clearNavigation };
}
