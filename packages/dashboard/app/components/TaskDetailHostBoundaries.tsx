import { useCallback, useRef } from "react";
import type { Task, TaskDetail } from "@fusion/core";
import { mergeTaskSnapshot } from "../hooks/useTasks";
import { useMainPanelTaskDetail } from "../hooks/useMainPanelTaskDetail";
import { usePoppedOutTasks, type PoppedOutTaskEntry } from "../hooks/usePoppedOutTasks";
import type { DetailTaskTab } from "../hooks/useModalManager";
import type { NavEntry } from "../hooks/useNavigationHistory";
import type { TaskView } from "../hooks/useViewState";
import { FloatingWindow } from "./FloatingWindow";
import { TaskDetailContent, TaskDetailModal, type TaskDetailContentProps, type TaskDetailModalProps } from "./TaskDetailModal";

export interface AppModalTaskDetailHostProps extends Omit<TaskDetailModalProps, "onClose"> {
  onRemoveNavigation: () => void;
  onCloseDetail: () => void;
  onCleanupDeepLink: () => void;
  onClosed?: () => void;
}

/*
FNXC:TaskDetailHeroUI 2026-09-11-13:24:
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
}

export function MainPanelTaskDetailHost({ onNavigateToBoard, mobileTransition = false, ...props }: MainPanelTaskDetailHostProps) {
  return (
    <div className={`task-detail-main-panel${mobileTransition ? " task-detail-main-panel--mobile-transition" : ""}`}>
      <div className="task-detail-main-panel-body">
        <TaskDetailContent {...props} embedded onBackToBoard={onNavigateToBoard} onRequestClose={onNavigateToBoard} />
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

export function AppTaskPopoutContent({ onRemoveWindow, ...props }: AppTaskPopoutContentProps) {
  return <TaskDetailContent {...props} embedded onRequestClose={onRemoveWindow} />;
}

export interface AppTaskPopoutWindowProps extends Omit<AppTaskPopoutContentProps, "onRemoveWindow"> {
  originTaskView?: TaskView;
  hidden: boolean;
  onRemoveWindow: () => void;
  persistGeometryKey: string;
}

export function AppTaskPopoutWindow({ task, originTaskView, hidden, onRemoveWindow, persistGeometryKey, ...props }: AppTaskPopoutWindowProps) {
  return (
    <FloatingWindow
      windowKey={`task-detail-${task.id}-${originTaskView ?? "global"}`}
      title={task.id}
      hidden={hidden}
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
FNXC:TaskDetailHeroUI 2026-09-11-13:46:
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
  isVisible: (originTaskView?: TaskView) => boolean;
  onCloseTask: (taskId: string, originTaskView?: TaskView) => void;
  persistGeometryKey: string;
  windowProps: Omit<AppTaskPopoutWindowProps, "task" | "originTaskView" | "initialTab" | "hidden" | "onRemoveWindow" | "persistGeometryKey">;
}

/*
FNXC:TaskDetailHeroUI 2026-09-11-14:05:
App's pop-out renderer must derive FloatingWindow dismissal from the same state owner that supplied each entry. Keeping entry identity, live snapshot merging, visibility, and close binding in this rendered composition prevents host tests from recreating a parallel callback.
*/
export function AppTaskPopoutWindows({ entries, liveTasks, isVisible, onCloseTask, persistGeometryKey, windowProps }: AppTaskPopoutWindowsProps) {
  return entries.map(({ task: snapshot, originTaskView, initialTab }) => {
    const current = liveTasks.find((candidate) => candidate.id === snapshot.id);
    const task = current ? mergeTaskSnapshot(snapshot, current) : snapshot;
    const visible = isVisible(originTaskView);
    return (
      <AppTaskPopoutWindow
        key={`${snapshot.id}:${originTaskView ?? "global"}`}
        {...windowProps}
        task={task}
        originTaskView={originTaskView}
        initialTab={initialTab}
        hidden={!visible}
        active={visible}
        persistGeometryKey={persistGeometryKey}
        onRemoveWindow={() => onCloseTask(snapshot.id, originTaskView)}
      />
    );
  });
}

export interface AppPoppedOutTaskStateOptions extends AppTaskDetailNavigation {
  taskView: TaskView;
  isMobile: boolean;
}

/*
FNXC:TaskDetailHeroUI 2026-09-11-13:46:
App's pop-out boundary owns each window entry and its mobile navigation callback as one state machine. Closing from either FloatingWindow chrome or Task Detail removes the exact origin-scoped entry and consumes its navigation record.
*/
export function useAppPoppedOutTaskState({ taskView, isMobile, pushNav, removeNav }: AppPoppedOutTaskStateOptions) {
  const { entries, popOut, close: closeEntry, closeAll } = usePoppedOutTasks();
  const navCloseRef = useRef(new Map<string, () => void>());
  const identity = (taskId: string, originTaskView?: TaskView) => `${taskId}:${originTaskView ?? "global"}`;

  const close = useCallback((taskId: string, originTaskView?: TaskView) => {
    const key = identity(taskId, originTaskView);
    const closeFromHistory = navCloseRef.current.get(key);
    if (closeFromHistory) {
      navCloseRef.current.delete(key);
      removeNav(closeFromHistory);
    }
    closeEntry(taskId, originTaskView);
  }, [closeEntry, removeNav]);

  const open = useCallback((nextTask: Task | TaskDetail, initialTab?: DetailTaskTab) => {
    const key = identity(nextTask.id, taskView);
    const alreadyOpen = entries.some((entry) => entry.task.id === nextTask.id && entry.originTaskView === taskView);
    if (isMobile && !alreadyOpen) {
      const closeFromHistory = () => {
        navCloseRef.current.delete(key);
        closeEntry(nextTask.id, taskView);
      };
      navCloseRef.current.set(key, closeFromHistory);
      pushNav({ type: "modal", close: closeFromHistory });
    }
    popOut(nextTask, taskView, initialTab);
  }, [closeEntry, entries, isMobile, popOut, pushNav, taskView]);

  const clearNavigation = useCallback(() => navCloseRef.current.clear(), []);

  return { entries, open, close, closeAll, clearNavigation };
}
