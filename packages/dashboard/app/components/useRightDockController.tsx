import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ColumnId, GithubIssueAction, MergeResult, Task, TaskDetail, WorkflowStep } from "@fusion/core";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate-canonical";
import type { ToastType } from "../hooks/useToast";
import type { DetailTaskTab } from "../hooks/useModalManager";
import { fetchTaskDetail } from "../api";
import { getScopedItem } from "../utils/projectStorage";
import { DOCK_FILES_CURRENT_KEY } from "./DockFilesView";
import { TaskCard } from "./TaskCard";
import { TaskDetailContent } from "./TaskDetailModal";
import { RightDock, persistRightDockOpen, persistRightDockPinned, readStoredRightDockOpen, readStoredRightDockPinned } from "./RightDock";
import { RightDockExpandModal } from "./RightDockExpandModal";
import type { OverflowViewKey, OverflowViewRenderProps, OverflowViewVisibilityOptions } from "./overflowViewRegistry";

export interface RightDockControllerInput {
  active: boolean;
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  settingsLoaded: boolean;
  researchReadinessVersion: number;
  goalAnchorId?: string;
  tasks: Array<Task | TaskDetail>;
  workflowSteps: WorkflowStep[];
  subscribePluginEvents: (pluginId: string, onEvent: (event: { event: string; payload: unknown }) => void) => () => void;
  openDetailTask: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
  openFileInBrowser: (path: string, opts?: { workspace?: string; line?: number; col?: number }) => void;
  onMoveTask: (id: string, column: ColumnId, optionsOrPosition?: { preserveProgress?: boolean } | number) => Promise<Task>;
  onDeleteTask: (id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; githubIssueAction?: GithubIssueAction; allowResurrection?: boolean }) => Promise<Task>;
  onArchiveTask?: (id: string, options?: { removeLineageReferences?: boolean }) => Promise<Task>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onRetryTask?: (id: string) => Promise<Task>;
  onResetTask?: (id: string) => Promise<Task>;
  onDuplicateTask?: (id: string) => Promise<Task>;
  onTaskUpdated?: (task: Task) => void;
  openSettings: (section?: string) => void;
  onOpenUsage?: (anchorRect?: DOMRect | null) => void;
  onOpenActivityLog?: () => void;
  onOpenGitHubImport?: () => void;
  onOpenGitManager?: () => void;
  onOpenSchedules?: () => void;
  onSendSelectionToTask: (description: string) => void;
  onCreateTaskFromInsight: (payload: { insightId: string; title: string; description: string }) => Promise<void> | void;
  onNavigateToMission: (missionId: string) => void;
  onTaskCreated: (task: Task) => void;
  prAuthAvailable: boolean;
  autoMerge: boolean;
  visibilityOptions: OverflowViewVisibilityOptions;
  footerVisible: boolean;
}

export interface RightDockController {
  open: boolean;
  toggle: () => void;
  pinned: boolean;
  togglePin: () => void;
  dock: ReactNode;
  modal: ReactNode;
  openTaskInDock: (task: Task | TaskDetail) => void;
  closeDockTask: () => void;
}

/*
FNXC:Navigation 2026-06-21-23:40:
The right dock is visible by default and collapses from inside the dock. Keep the persisted open/collapsed state in this controller so App and Header do not need duplicate right-dock toggle wiring.

FNXC:RightDock 2026-06-22-18:50:
The popped-out expand modal is INDEPENDENT of the dock's open state. `expandedView` and the modal it drives live at the controller level (a sibling of `dock`, NOT a child of RightDock — which early-returns null when closed). Toggling the dock closed must therefore NOT clear `expandedView`: once a view is popped out it stays open and interactive even with the dock hidden, and only its own close button (`onClose -> setExpandedView(null)`) dismisses it. We still clear `expandedView` when the surface becomes inactive (project change/teardown) because that unmounts the whole controller surface, not a user dock-hide.
*/
export function useRightDockController(input: RightDockControllerInput): RightDockController {
  const [open, setOpen] = useState(readStoredRightDockOpen);
  /*
  FNXC:RightDockPin 2026-06-27-00:00:
  Pin state is owned next to open state so the Header toggle, dock render, and pop-out modal share one controller contract. The flag persists independently of open/expanded state: closing or popping out the dock must not erase the user's overlay-vs-push preference.
  */
  const [pinned, setPinned] = useState(readStoredRightDockPinned);
  const [expandedView, setExpandedView] = useState<OverflowViewKey | null>(null);
  const [dockTaskSnapshot, setDockTaskSnapshot] = useState<Task | TaskDetail | null>(null);

  const closeDockTask = useCallback(() => {
    setDockTaskSnapshot(null);
  }, []);

  const openTaskInDock = useCallback((task: Task | TaskDetail) => {
    setDockTaskSnapshot(task);
    setOpen(true);
    persistRightDockOpen(true);
  }, []);

  const resolvedDockTask = useMemo(() => {
    if (!dockTaskSnapshot) return null;
    return input.tasks.find((candidate) => candidate.id === dockTaskSnapshot.id) ?? dockTaskSnapshot;
  }, [dockTaskSnapshot, input.tasks]);

  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      persistRightDockOpen(next);
      // FNXC:RightDock 2026-06-22-18:50: Do NOT clear expandedView on dock-hide; the floating pop-out is independent and survives the dock closing.
      return next;
    });
  }, []);

  const togglePin = useCallback(() => {
    setPinned((current) => {
      const next = !current;
      persistRightDockPinned(next);
      return next;
    });
  }, []);

  /*
  FNXC:RightDock 2026-06-22-19:25:
  Popping a view out CLOSES the right dock but KEEPS the floating modal open. The modal is independent of dock open state (see expandedView note above), so collapsing the dock on pop-out gives the user the full-width app behind the movable, non-blocking modal. Clearing the pop-out (viewKey null) leaves the dock as-is.
  */
  const handleExpand = useCallback((viewKey: OverflowViewKey | null) => {
    /*
    FNXC:RightDockFiles 2026-06-23-23:38:
    If Files is showing an individual file, Expand should open the existing FileBrowserModal at that file instead of the generic right-dock expanded panel. The file modal is the shared movable/resizable file surface and keeps its transparent, non-blurring FloatingWindow backdrop; an empty Files view still expands to the two-pane browser.
    */
    if (viewKey === "files") {
      const currentFile = getScopedItem(DOCK_FILES_CURRENT_KEY, input.projectId);
      if (currentFile) {
        input.openFileInBrowser(currentFile, { workspace: "project" });
        setOpen(false);
        persistRightDockOpen(false);
        setExpandedView(null);
        return;
      }
    }

    setExpandedView(viewKey);
    if (viewKey) {
      setOpen(false);
      persistRightDockOpen(false);
    }
  }, [input]);

  useEffect(() => {
    if (!input.active) {
      setExpandedView(null);
      setDockTaskSnapshot(null);
    }
  }, [input.active]);

  const renderTaskCard = useCallback((task: Task | TaskDetail) => (
    <TaskCard
      task={task}
      projectId={input.projectId}
      onOpenDetail={(value: Task | TaskDetail) => input.openDetailTask(value)}
      addToast={input.addToast}
      disableDrag={true}
      prAuthAvailable={input.prAuthAvailable}
      autoMergeEnabled={input.autoMerge}
      nearDuplicateCanonicalInactive={typeof task.sourceMetadata?.nearDuplicateOf === "string"
        ? isNearDuplicateCanonicalInactive(input.tasks.find((candidate) => candidate.id === task.sourceMetadata?.nearDuplicateOf))
        : undefined}
    />
  ), [input]);

  const renderProps = useMemo<OverflowViewRenderProps>(() => ({
    projectId: input.projectId,
    addToast: input.addToast,
    settingsLoaded: input.settingsLoaded,
    readinessVersion: input.researchReadinessVersion,
    anchorGoalId: input.goalAnchorId,
    tasks: input.tasks,
    workflowSteps: input.workflowSteps,
    pluginContext: {
      projectId: input.projectId,
      tasks: input.tasks as Task[],
      workflowSteps: input.workflowSteps,
      subscribePluginEvents: input.subscribePluginEvents,
      openTaskDetail: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => input.openDetailTask(task, initialTab),
      openFile: input.openFileInBrowser,
      renderTaskCard,
      addToast: input.addToast,
    },
    onOpenSettings: input.openSettings,
    onOpenUsage: input.onOpenUsage,
    onOpenActivityLog: input.onOpenActivityLog,
    onOpenGitHubImport: input.onOpenGitHubImport,
    onOpenGitManager: input.onOpenGitManager,
    onOpenSchedules: input.onOpenSchedules,
    onOpenTaskDetail: (taskId: string) => {
      void fetchTaskDetail(taskId, input.projectId)
        .then((task) => input.openDetailTask(task as TaskDetail))
        .catch((error) => input.addToast(error instanceof Error ? error.message : "Failed to open task detail", "error"));
    },
    /*
    FNXC:RightDockTasks 2026-06-28-17:05:
    DockTaskList rows must open the in-dock Tasks detail, not the canonical full task modal. Thread the existing dock snapshot setter into registry render props so both compact and expanded Tasks lists route TaskCard's internal open action to the Tasks tab.
    */
    onOpenTaskInDock: openTaskInDock,
    onOpenDetail: input.openDetailTask,
    onSendSelectionToTask: input.onSendSelectionToTask,
    onCreateTaskFromInsight: input.onCreateTaskFromInsight,
    onNavigateToMission: input.onNavigateToMission,
    onPlanningMode: input.onSendSelectionToTask,
    onTaskCreated: input.onTaskCreated,
    renderTaskCard,
    subscribePluginEvents: input.subscribePluginEvents,
    openFile: input.openFileInBrowser,
  }), [input, openTaskInDock, renderTaskCard]);

  const dockTaskContent = resolvedDockTask ? (
    /*
    FNXC:OpenTasksInRightSidebar 2026-06-28-00:00:
    Board-routed right-sidebar task detail reuses the embedded TaskDetailContent surface so task actions, dependency links, and pop-out semantics stay aligned with the full-panel and list split-detail hosts. The controller resolves a live task row by id and falls back to the clicked snapshot so revalidation never blanks the dock.
    */
    <TaskDetailContent
      task={resolvedDockTask}
      projectId={input.projectId}
      tasks={input.tasks as Task[]}
      embedded
      onRequestClose={closeDockTask}
      onOpenDetail={(value) => input.openDetailTask(value, "chat")}
      onMoveTask={input.onMoveTask}
      onDeleteTask={input.onDeleteTask}
      onArchiveTask={input.onArchiveTask}
      onMergeTask={input.onMergeTask}
      onRetryTask={input.onRetryTask}
      onResetTask={input.onResetTask}
      onDuplicateTask={input.onDuplicateTask}
      onTaskUpdated={input.onTaskUpdated}
      addToast={input.addToast}
      prAuthAvailable={input.prAuthAvailable}
      autoMergeEnabled={input.autoMerge}
    />
  ) : null;

  return {
    open,
    toggle,
    pinned,
    togglePin,
    openTaskInDock,
    closeDockTask,
    dock: input.active ? <RightDock open={open} renderProps={renderProps} visibilityOptions={input.visibilityOptions} footerVisible={input.footerVisible} pinned={pinned} onTogglePin={togglePin} onExpand={handleExpand} dockTask={resolvedDockTask} dockTaskContent={dockTaskContent} onCloseDockTask={closeDockTask} /> : null,
    modal: input.active ? <RightDockExpandModal viewKey={expandedView} renderProps={renderProps} visibilityOptions={input.visibilityOptions} onClose={() => setExpandedView(null)} /> : null,
  };
}
