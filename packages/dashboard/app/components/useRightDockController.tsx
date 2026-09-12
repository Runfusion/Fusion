import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { GithubIssueAction, MergeResult, ProjectNoteSummary, Task, TaskDetail, WorkflowStep } from "@fusion/core";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/duplicates/near-duplicate-canonical";
import type { ToastType } from "../hooks/useToast";
import type { UseNotesController } from "../hooks/useNotes";
import type { ChatSessionInfo } from "../hooks/useChat";
import type { DetailTaskTab } from "../hooks/useModalManager";
import { fetchTaskDetail } from "../api";
import type { RevertTaskOptions, RevertTaskResult } from "../api";
import { TaskCard } from "./TaskCard";
import { RightDockTaskDetailHost } from "./TaskDetailHostBoundaries";
import { mergeTaskSnapshot } from "../hooks/useTasks";
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
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-04:00 (batch-dashboard-app — the dock-wide fix):
  Per-task column traits for every view the dock hosts. DevServerView and plugin task cards consume
  this shared index rather than falling back to legacy column ids. Reuse the map App already builds
  for the footer; no new resolution.
  */
  columnFlagsByTaskId?: ReadonlyMap<string, { complete?: boolean; countsTowardWip?: boolean; mergeBlocker?: boolean; humanReview?: boolean; intake?: boolean; hold?: boolean }>;
  workflowSteps: WorkflowStep[];
  subscribePluginEvents: (pluginId: string, onEvent: (event: { event: string; payload: unknown }) => void) => () => void;
  openDetailTask: (task: Task | TaskDetail, initialTab?: DetailTaskTab) => void;
  onOpenSessionInNewWindow?: (session: ChatSessionInfo) => void;
  openChatWindows?: ReadonlyMap<string, "open" | "minimized">;
  notesController?: UseNotesController;
  onOpenNote?: (note: ProjectNoteSummary) => void;
  registerNotesGuard?: (guard: () => boolean | Promise<boolean>, onAccepted?: () => void) => () => void;
  openFileInBrowser: (path: string, opts?: { workspace?: string; line?: number; col?: number }) => void;
  onUpdateTask?: (id: string, updates: { title?: string; description?: string; dependencies?: string[]; dismissNearDuplicate?: boolean; githubTracking?: { enabled?: boolean } }) => Promise<Task>;
  onDeleteTask: (id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; githubIssueAction?: GithubIssueAction; allowResurrection?: boolean }) => Promise<Task>;
  onRevertTask?: (id: string, body?: RevertTaskOptions) => Promise<RevertTaskResult>;
  onMergeTask: (id: string) => Promise<MergeResult>;
  onRetryTask?: (id: string) => Promise<Task>;
  onOpenChatWithPrefill?: (prefillText: string) => void;
  onPauseTask?: (id: string) => Promise<Task>;
  onUnpauseTask?: (id: string) => Promise<Task>;
  /* FNXC:ReviewLaneBypass 2026-07-09-00:00 (FN-7720): threaded through so the right-dock host renders the same TaskDetailContent bypass affordance as the full modal/floating hosts. */
  onBypassReview?: (id: string, reason: string) => Promise<Task>;
  onResetTask?: (id: string, options?: { description?: string }) => Promise<Task>;
  onDuplicateTask?: (id: string, options?: { workflowId?: string }) => Promise<Task>;
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
  taskDetailChatFirst: boolean;
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
The right dock is HIDDEN by default (no stored preference -> closed; see readStoredRightDockOpen, updated 2026-07-03) so first-run/onboarding lands on an uncluttered board; the operator opts in via the Header toggle. Keep the persisted open/collapsed state in this controller so App and Header do not need duplicate right-dock toggle wiring.

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
  const [dockTaskSnapshot, setDockTaskSnapshot] = useState<{
    projectId: string | undefined;
    task: Task | TaskDetail;
  } | null>(null);

  const closeDockTask = useCallback(() => {
    setDockTaskSnapshot(null);
  }, []);

  const openTaskInDock = useCallback((task: Task | TaskDetail) => {
    setDockTaskSnapshot({ projectId: input.projectId, task });
    setOpen(true);
    persistRightDockOpen(true);
  }, [input.projectId]);

  const resolvedDockTask = useMemo(() => {
    /*
    FNXC:RightDockTaskDetail 2026-09-12-02:18:
    A project-switch render happens before the cleanup effect commits. Fence the transient snapshot by
    its capture-time project identity so Task Detail cannot mount or run effects against the next project.
    */
    if (!dockTaskSnapshot || dockTaskSnapshot.projectId !== input.projectId) return null;
    const snapshotTask = dockTaskSnapshot.task;
    const liveTask = input.tasks.find((candidate) => candidate.id === snapshotTask.id);
    return liveTask ? mergeTaskSnapshot(snapshotTask, liveTask) : snapshotTask;
  }, [dockTaskSnapshot, input.projectId, input.tasks]);

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
    setExpandedView(viewKey);
    if (viewKey) {
      setOpen(false);
      persistRightDockOpen(false);
    }
  }, [input]);

  useEffect(() => {
    /*
    FNXC:RightDockTaskDetail 2026-09-12-02:04:
    Temporary task detail is project-scoped even when the dock remains active across a direct project switch. Clear both transient surfaces whenever project identity changes so an equal task id in the next project cannot merge with or display the previous project's snapshot.
    */
    setExpandedView(null);
    setDockTaskSnapshot(null);
  }, [input.active, input.projectId]);

  const renderTaskCard = useCallback((task: Task | TaskDetail) => (
    <TaskCard
      task={task}
      /* Plugin- and dock-rendered cards resolved NO traits before this, so every role helper inside
         the card fell back to the legacy id. The map is already in scope for the canonical lookup
         below — the card itself was simply never given it. */
      taskColumnFlags={input.columnFlagsByTaskId?.get(task.id)}
      projectId={input.projectId}
      onOpenDetail={(value: Task | TaskDetail) => input.openDetailTask(value)}
      onOpenChatWithPrefill={input.onOpenChatWithPrefill}
      onDeleteTask={input.onDeleteTask}
      onUpdateTask={input.onUpdateTask}
      addToast={input.addToast}
      prAuthAvailable={input.prAuthAvailable}
      autoMergeEnabled={input.autoMerge}
      nearDuplicateCanonicalInactive={typeof task.sourceMetadata?.nearDuplicateOf === "string"
        ? (() => {
          /* FNXC:WorkflowResolvedColumns 2026-07-30-23:30: the canonical's own flags, from the map
             this controller already threads to every dock view. */
          const canonical = input.tasks.find((candidate) => candidate.id === task.sourceMetadata?.nearDuplicateOf);
          return isNearDuplicateCanonicalInactive(canonical, canonical ? input.columnFlagsByTaskId?.get(canonical.id) : undefined);
        })()
        : undefined}
    />
  ), [input]);

  const renderProps = useMemo<OverflowViewRenderProps>(() => ({
    projectId: input.projectId,
    hostMode: input.visibilityOptions.hostMode ?? "standard",
    experimentalFeatures: input.visibilityOptions.experimentalFeatures,
    addToast: input.addToast,
    settingsLoaded: input.settingsLoaded,
    readinessVersion: input.researchReadinessVersion,
    anchorGoalId: input.goalAnchorId,
    tasks: input.tasks,
    columnFlagsByTaskId: input.columnFlagsByTaskId,
    onUpdateTask: input.onUpdateTask,
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
    FNXC:TaskRevert 2026-08-01-20:06:
    Dock resolution uses the same New Task prefill owner as every other surface.
    Keeping this callback in registry props lets compact and expanded dock hosts revise
    the exact source description without introducing a second draft state.
    */
    onReviseTask: (task: Task | TaskDetail) => input.onSendSelectionToTask(task.description),
    onDeleteTask: input.onDeleteTask,
    onOpenChatWithPrefill: input.onOpenChatWithPrefill,
    onOpenDetail: input.openDetailTask,
    onOpenSessionInNewWindow: input.onOpenSessionInNewWindow,
    openChatWindows: input.openChatWindows,
    notesController: input.notesController,
    onOpenNote: input.onOpenNote,
    registerNotesGuard: input.registerNotesGuard,
    onSendSelectionToTask: input.onSendSelectionToTask,
    onCreateTaskFromInsight: input.onCreateTaskFromInsight,
    onNavigateToMission: input.onNavigateToMission,
    onPlanningMode: input.onSendSelectionToTask,
    onTaskCreated: input.onTaskCreated,
    renderTaskCard,
    subscribePluginEvents: input.subscribePluginEvents,
    openFile: input.openFileInBrowser,
  }), [input, renderTaskCard]);

  const dockTaskContent = resolvedDockTask ? (
    /*
    FNXC:OpenTasksInRightSidebar 2026-06-28-00:00:
    Board-routed right-sidebar task detail reuses the embedded TaskDetailContent surface so task actions, dependency links, and pop-out semantics stay aligned with the full-panel and list split-detail hosts. The controller resolves a live task row by id and falls back to the clicked snapshot so revalidation never blanks the dock.
    */
    <RightDockTaskDetailHost
      task={resolvedDockTask}
      projectId={input.projectId}
      tasks={input.tasks as Task[]}
      onCloseDock={closeDockTask}
      onOpenDetail={(value, initialTab) => input.openDetailTask(value, initialTab ?? "chat")}
      /* FNXC:TaskRevert 2026-08-01-20:27: Right-dock task detail uses the shared New Task draft recovery for reverted tasks. */
      onReviseTask={(task) => input.onSendSelectionToTask(task.description)}
      onDeleteTask={input.onDeleteTask}
      onRevertTask={input.onRevertTask}
      onMergeTask={input.onMergeTask}
      onRetryTask={input.onRetryTask}
      onOpenChatWithPrefill={input.onOpenChatWithPrefill}
      onPauseTask={input.onPauseTask}
      onUnpauseTask={input.onUnpauseTask}
      onBypassReview={input.onBypassReview}
      onResetTask={input.onResetTask}
      onDuplicateTask={input.onDuplicateTask}
      onTaskUpdated={input.onTaskUpdated}
      onRefinementCreated={input.onTaskCreated}
      addToast={input.addToast}
      prAuthAvailable={input.prAuthAvailable}
      autoMergeEnabled={input.autoMerge}
      taskDetailChatFirst={input.taskDetailChatFirst}
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
