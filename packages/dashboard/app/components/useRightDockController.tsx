import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Task, TaskDetail, WorkflowStep } from "@fusion/core";
import { isNearDuplicateCanonicalInactive } from "../../../core/src/near-duplicate-canonical";
import type { ToastType } from "../hooks/useToast";
import type { DetailTaskTab } from "../hooks/useModalManager";
import { fetchTaskDetail } from "../api";
import { TaskCard } from "./TaskCard";
import { RightDock, persistRightDockOpen, readStoredRightDockOpen } from "./RightDock";
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
  workflowStepNameLookup: Map<string, string>;
  prAuthAvailable: boolean;
  autoMerge: boolean;
  visibilityOptions: OverflowViewVisibilityOptions;
  footerVisible: boolean;
}

export interface RightDockController {
  open: boolean;
  toggle: () => void;
  dock: ReactNode;
  modal: ReactNode;
}

/*
FNXC:Navigation 2026-06-21-23:40:
The right dock is visible by default and collapses from inside the dock. Keep the persisted open/collapsed state in this controller so App and Header do not need duplicate right-dock toggle wiring.

FNXC:RightDock 2026-06-22-18:50:
The popped-out expand modal is INDEPENDENT of the dock's open state. `expandedView` and the modal it drives live at the controller level (a sibling of `dock`, NOT a child of RightDock — which early-returns null when closed). Toggling the dock closed must therefore NOT clear `expandedView`: once a view is popped out it stays open and interactive even with the dock hidden, and only its own close button (`onClose -> setExpandedView(null)`) dismisses it. We still clear `expandedView` when the surface becomes inactive (project change/teardown) because that unmounts the whole controller surface, not a user dock-hide.
*/
export function useRightDockController(input: RightDockControllerInput): RightDockController {
  const [open, setOpen] = useState(readStoredRightDockOpen);
  const [expandedView, setExpandedView] = useState<OverflowViewKey | null>(null);

  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      persistRightDockOpen(next);
      // FNXC:RightDock 2026-06-22-18:50: Do NOT clear expandedView on dock-hide; the floating pop-out is independent and survives the dock closing.
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
  }, []);

  useEffect(() => {
    if (!input.active) setExpandedView(null);
  }, [input.active]);

  const renderTaskCard = useCallback((task: Task | TaskDetail) => (
    <TaskCard
      task={task}
      projectId={input.projectId}
      onOpenDetail={(value: Task | TaskDetail) => input.openDetailTask(value)}
      addToast={input.addToast}
      workflowStepNameLookup={input.workflowStepNameLookup}
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
    onOpenDetail: input.openDetailTask,
    onSendSelectionToTask: input.onSendSelectionToTask,
    onCreateTaskFromInsight: input.onCreateTaskFromInsight,
    onNavigateToMission: input.onNavigateToMission,
    onPlanningMode: input.onSendSelectionToTask,
    onTaskCreated: input.onTaskCreated,
    renderTaskCard,
    subscribePluginEvents: input.subscribePluginEvents,
    openFile: input.openFileInBrowser,
  }), [input, renderTaskCard]);

  return {
    open,
    toggle,
    dock: input.active ? <RightDock open={open} renderProps={renderProps} visibilityOptions={input.visibilityOptions} footerVisible={input.footerVisible} onExpand={handleExpand} /> : null,
    modal: input.active ? <RightDockExpandModal viewKey={expandedView} renderProps={renderProps} visibilityOptions={input.visibilityOptions} onClose={() => setExpandedView(null)} /> : null,
  };
}
