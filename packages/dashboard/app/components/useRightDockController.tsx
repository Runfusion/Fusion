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
FNXC:Navigation 2026-06-21-12:20:
App owns whether the default-on right dock is available, but this controller owns the persisted open state and shared view props so App.tsx does not duplicate each overflow destination's dock/modal rendering contract.
*/
export function useRightDockController(input: RightDockControllerInput): RightDockController {
  const [open, setOpen] = useState(readStoredRightDockOpen);
  const [expandedView, setExpandedView] = useState<OverflowViewKey | null>(null);

  const setPersistedOpen = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    persistRightDockOpen(nextOpen);
    if (!nextOpen) setExpandedView(null);
  }, []);
  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      persistRightDockOpen(next);
      if (!next) setExpandedView(null);
      return next;
    });
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
    dock: input.active ? <RightDock open={open} onOpenChange={setPersistedOpen} renderProps={renderProps} visibilityOptions={input.visibilityOptions} footerVisible={input.footerVisible} onExpand={setExpandedView} /> : null,
    modal: input.active ? <RightDockExpandModal viewKey={expandedView} renderProps={renderProps} visibilityOptions={input.visibilityOptions} onClose={() => setExpandedView(null)} /> : null,
  };
}
